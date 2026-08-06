import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, join, sep } from "node:path";
import { LEDGER_SCHEMA_VERSION, NAME_RE } from "./ledger.js";
import type { AssetKind, HistoryFacts, LedgerChannel, LedgerEvent, Skill, SkillUsage } from "./types.js";

interface Invocation {
  name: string;
  kind: AssetKind;
  sessionId: string;
  file: string;
  lineNo: number;
  timestamp?: string;
  /** Ledger-shaped record; absent when the line carried no timestamp or no parseable JSON. */
  event?: LedgerEvent;
}

/** An interrupt this many lines or fewer after an invocation is attributed to it. */
const INTERRUPT_WINDOW = 15;

export function findJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    // Name-sorted walk: event order must never depend on readdir order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export const TS_RE = /"timestamp"\s*:\s*"([^"]+)"/;
const COMMAND_RE = /<command-name>\/?([A-Za-z0-9:_-]+)<\/command-name>/;
const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/;
/**
 * First stage of the bundled-read gate. Every file-touching tool carries this
 * key, so one substring test per line replaces a per-line JSON.parse — the
 * Read tool is one of the most common lines in a transcript and parsing all of
 * them would roughly double the cost of a walk over thousands of files. Stage
 * two extracts the paths, stage three parses only the rare line whose path
 * actually lands inside a tracked asset.
 */
const FILE_PATH_KEY = '"file_path"';
const FILE_PATH_RE = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
/**
 * Present on every assistant line that reports token usage. Only ever tested
 * on `subagents/agent-*.jsonl` lines, so non-agent transcripts pay nothing.
 */
const USAGE_KEY = '"output_tokens"';
// Fast reject before JSON.parse — most lines carry none of the launches we
// track. "Agent" and "Task" are the same launcher under different CLI versions.
const TOOL_MARKERS = [
  '"name":"Skill"',
  '"name": "Skill"',
  '"name":"Agent"',
  '"name": "Agent"',
  '"name":"Task"',
  '"name": "Task"',
];

/**
 * Usage fields arrive from a transcript, not from a type-checked API: a NaN or
 * a negative would silently poison a whole run's total, and no consumer could
 * tell that sum from a real one afterwards.
 */
function tokenField(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
}

/** Session a transcript belongs to: subagent files sit under `<sessionId>/subagents/`. */
function sessionFromPath(file: string): string {
  const parts = file.split(sep);
  const i = parts.lastIndexOf("subagents");
  return i > 0 ? parts[i - 1] : basename(file, ".jsonl");
}

export async function historyFacts(transcriptsDir: string, skills: Skill[]): Promise<HistoryFacts> {
  const files = existsSync(transcriptsDir) ? findJsonlFiles(transcriptsDir) : [];
  const invocations: Invocation[] = [];
  const events: LedgerEvent[] = [];
  const interruptedInvocations = new Set<Invocation>();
  let windowStart: string | undefined;
  let windowEnd: string | undefined;

  // The transcript records the dispatch token, not what it resolved to; the
  // inventory says which kinds that token is installed as. The dispatch
  // channel is evidence: a Skill tool_use firing a name installed as both a
  // skill and a command belongs to the skill row, a typed command to the
  // command row — a name is never handed to one kind because it was
  // discovered last.
  const kindsByName = new Map<string, Set<AssetKind>>();
  for (const s of skills) {
    const k = s.kind ?? "skill";
    const set = kindsByName.get(s.dirName);
    if (set) set.add(k);
    else kindsByName.set(s.dirName, new Set([k]));
  }
  const resolveKind = (name: string, channelKind: AssetKind): AssetKind => {
    const set = kindsByName.get(name);
    if (!set || set.has(channelKind)) return channelKind;
    return set.size === 1 ? [...set][0] : channelKind;
  };

  // "Does this skill's bundled reference actually get read?" is answered by
  // matching Read paths against the inventory's own directories — stat'ing a
  // path per line would cost a syscall on every Read in every transcript, and
  // the filesystem cannot say which asset owns a path anyway. Roots are
  // indexed by exact string and a path is resolved by walking its OWN
  // ancestors, so the cost is the path's depth, not the size of the inventory.
  const assetRoots = new Set<string>();
  for (const s of skills) {
    const root = s.dir?.replace(/[\\/]+$/, "");
    if (root) assetRoots.add(root);
  }
  const rootOf = (p: string): string | undefined => {
    // Longest ancestor wins: a skill directory nested inside another asset's
    // tree owns its own files, and crediting the outer asset would report a
    // read of a file it does not ship.
    let i = p.lastIndexOf(sep);
    while (i > 0) {
      const d = p.slice(0, i);
      if (assetRoots.has(d)) return d;
      i = p.lastIndexOf(sep, i - 1);
    }
    return undefined;
  };
  // Sessions, not a raw count: the same skill gets read in sessions where it
  // never fired (someone just opened the file), so only the session sets let
  // the join state the fact as a share of THAT asset's fires instead of an
  // unanchored number that quietly counts browsing as use.
  const readsByFile = new Map<string, { dir: string; relPath: string; sessions: Set<string> }>();
  // agentId → tokens summed from that agent's own transcript.
  const agentTokens = new Map<string, number>();

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    const pathSession = sessionFromPath(file);
    const pathAgentId = AGENT_FILE_RE.exec(basename(file))?.[1];
    // tool_use id → event, awaiting its tool_result later in the same file.
    const pending = new Map<string, LedgerEvent>();
    let lineNo = 0;
    const recent: Invocation[] = [];
    // One assistant response is written as several transcript lines (text,
    // then each tool_use) that repeat the SAME message.id carrying the SAME
    // usage object; summing per line would multiply a run's cost by how many
    // blocks it happened to be split into.
    const usageSeen = pathAgentId ? new Set<string>() : undefined;

    const buildEvent = (
      obj: any,
      id: string,
      ts: string,
      kind: AssetKind,
      name: string,
      channel: LedgerChannel,
      sessionId: string,
      caller?: unknown
    ): LedgerEvent => {
      const e: LedgerEvent = {
        v: LEDGER_SCHEMA_VERSION,
        id,
        ts,
        provider: "claude",
        kind,
        name,
        channel,
        sessionId,
        project: typeof obj.cwd === "string" ? obj.cwd : "",
        src: { file, line: lineNo },
      };
      const model = obj?.message?.model;
      // "<synthetic>" marks harness-injected lines, not a model's choice.
      if (typeof model === "string" && model !== "<synthetic>") e.model = model;
      if (typeof obj.entrypoint === "string") e.entrypoint = obj.entrypoint;
      const callerType = (caller as { type?: unknown } | undefined)?.type;
      if (typeof callerType === "string") e.caller = callerType;
      const agentId = typeof obj.agentId === "string" ? obj.agentId : pathAgentId;
      if (agentId) e.agent = { id: agentId, type: typeof obj.attributionAgent === "string" ? obj.attributionAgent : "" };
      return e;
    };

    for await (const line of rl) {
      lineNo++;
      const ts = TS_RE.exec(line)?.[1];
      if (ts) {
        if (!windowStart || ts < windowStart) windowStart = ts;
        if (!windowEnd || ts > windowEnd) windowEnd = ts;
      }

      const hitIds: string[] = [];
      if (pending.size > 0 && line.includes('"tool_use_id"')) {
        for (const id of pending.keys()) if (line.includes(id)) hitIds.push(id);
      }
      const wantsTool = TOOL_MARKERS.some((m) => line.includes(m));
      const wantsCmd = line.includes("<command-name>");
      // Second stage of the bundled-read gate: pull the candidate paths out of
      // the raw line and keep going only if one of them lands under a tracked
      // asset. An escaped path (a Windows separator) cannot be matched against
      // an unescaped root, so it defers the decision to the parse rather than
      // guessing at raw text and silently dropping a real read.
      let wantsRead = false;
      if (assetRoots.size > 0 && line.includes(FILE_PATH_KEY)) {
        FILE_PATH_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FILE_PATH_RE.exec(line)) !== null) {
          if (m[1].includes("\\") || rootOf(m[1])) {
            wantsRead = true;
            break;
          }
        }
      }
      const wantsUsage = pathAgentId !== undefined && line.includes(USAGE_KEY);
      let obj: any;
      if (wantsTool || wantsCmd || hitIds.length > 0 || wantsRead || wantsUsage) {
        try {
          obj = JSON.parse(line);
        } catch {}
      }
      const lineTs = typeof obj?.timestamp === "string" ? obj.timestamp : ts;
      const sessionId = typeof obj?.sessionId === "string" && obj.sessionId ? obj.sessionId : pathSession;
      const content = obj?.message?.content;

      // Per-AGENT run cost, the one cost figure this tool can state without a
      // confound: the agent's whole run lives in this file and nothing else's
      // work is interleaved with it (per-SKILL cost has no such file and stays
      // out of the product).
      //
      // METHOD, stated here because the UI has to label it: this sums TOTAL
      // TOKENS PROCESSED — `input_tokens + output_tokens +
      // cache_creation_input_tokens + cache_read_input_tokens` — over the
      // agent's own transcript. All four, because on a long run most of the
      // volume sits in the cache fields and a sum that quietly dropped them
      // would report a fraction of a run as the whole of it. The nested
      // `cache_creation` breakdown is never added: it re-states
      // cache_creation_input_tokens split by TTL and would double-count it.
      // This is a token count, not a bill — cached input is priced far below
      // fresh input, so no dollar figure may be derived from it.
      if (wantsUsage && usageSeen && pathAgentId) {
        const msg = obj?.message;
        const u = msg?.usage;
        // "<synthetic>" lines are harness-injected, not a model's work — the
        // same exclusion the model capture applies.
        if (u && typeof u === "object" && msg?.model !== "<synthetic>") {
          const mid = typeof msg.id === "string" ? msg.id : undefined;
          if (!mid || !usageSeen.has(mid)) {
            if (mid) usageSeen.add(mid);
            const sum =
              tokenField(u.input_tokens) +
              tokenField(u.output_tokens) +
              tokenField(u.cache_creation_input_tokens) +
              tokenField(u.cache_read_input_tokens);
            agentTokens.set(pathAgentId, (agentTokens.get(pathAgentId) ?? 0) + sum);
          }
        }
      }

      // Outcomes: a result line names its tool_use id. Rejection also sets
      // is_error, so it is checked first; `success` absent (agent launches
      // never carry it) is not a failure claim.
      for (const id of hitIds) {
        const ev = pending.get(id);
        if (!ev || !Array.isArray(content)) continue;
        let sawResult = false;
        let isErr = false;
        for (const b of content) {
          if (b?.type === "tool_result" && b?.tool_use_id === id) {
            sawResult = true;
            if (b?.is_error === true) isErr = true;
          }
        }
        if (!sawResult) continue;
        pending.delete(id);
        const tur = obj.toolUseResult;
        // The launch line itself carries no agentId — only the subagent's own
        // transcript lines do — so the RESULT is the single place the spawned
        // agent's id is visible, and without it nothing links a launch to the
        // `subagents/agent-<id>.jsonl` its run cost is summed from. `type` is
        // the subagent_type that was dispatched, which is this event's name.
        // Written only when the launch has no attribution of its own: a launch
        // made from INSIDE a sidechain already uses `agent` to say which
        // sidechain the fire happened in, and overwriting that would change
        // what the field means for every event a consumer reads.
        if (
          ev.kind === "agent" &&
          !ev.agent &&
          tur &&
          typeof tur === "object" &&
          typeof tur.agentId === "string" &&
          tur.agentId
        ) {
          ev.agent = { id: tur.agentId, type: ev.name };
        }
        if (tur === "User rejected tool use") ev.outcome = "rejected";
        else if (isErr || (tur && typeof tur === "object" && "success" in tur && tur.success !== true)) ev.outcome = "error";
        else ev.outcome = "ok";
      }

      if ((wantsTool || wantsRead) && Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_use") continue;
          // Third stage: only a genuine Read block counts. Edit and Write
          // carry the same `file_path` key and got this far, but "the model
          // read the skill's reference" and "the model rewrote it" are
          // different facts and must not be pooled.
          if (b.name === "Read") {
            const p = b.input?.file_path;
            if (typeof p !== "string") continue;
            const root = rootOf(p);
            if (!root) continue;
            const relPath = p.slice(root.length + 1);
            const key = `${root}\0${relPath}`;
            const rec = readsByFile.get(key);
            // By sessionId for the same reason fires are: a read inside a
            // subagent transcript belongs to the session that launched the
            // agent, so it can be intersected with that session's fires.
            if (rec) rec.sessions.add(sessionId);
            else readsByFile.set(key, { dir: root, relPath, sessions: new Set([sessionId]) });
            continue;
          }
          let name: string;
          let kind: AssetKind;
          if (b.name === "Skill" && typeof b.input?.skill === "string") {
            // Verbatim dispatch token — plugin:skill namespacing kept.
            name = b.input.skill;
            kind = resolveKind(name, "skill");
          } else if ((b.name === "Agent" || b.name === "Task") && typeof b.input?.subagent_type === "string") {
            name = b.input.subagent_type;
            kind = "agent";
          } else {
            continue;
          }
          // Dispatch tokens only — anything shaped like args or prose is
          // refused, the same gate the hooks writer applies. Both writers of
          // the event stream must agree on what a name is.
          if (!NAME_RE.test(name)) continue;
          const inv: Invocation = { name, kind, sessionId, file, lineNo, timestamp: lineTs };
          // The id exists only to be the ledger dedupe key: a block without
          // one still counts as an invocation — it just cannot yield an event.
          if (lineTs && typeof b.id === "string") {
            const ev = buildEvent(obj, `${sessionId}:${b.id}`, lineTs, kind, name, "auto", sessionId, b.caller);
            inv.event = ev;
            pending.set(b.id, ev);
            events.push(ev);
          }
          invocations.push(inv);
          recent.push(inv);
        }
      }

      // A typed command is a USER turn whose own prompt text carries the
      // marker. Assistant text or tool output QUOTING the literal marker is
      // not a fire — third-party content must never forge one. The raw line
      // is matched only as the fallback for unparseable lines: those still
      // count (the regex saw them) but cannot yield a ledger event.
      let cmdText: string | undefined;
      if (obj === undefined) {
        cmdText = line;
      } else if (obj.type === "user" && !("toolUseResult" in obj)) {
        const mc = obj.message?.content;
        if (typeof mc === "string") cmdText = mc;
        else if (Array.isArray(mc)) {
          cmdText = mc
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n");
        }
      }
      const cmd = cmdText === undefined ? null : COMMAND_RE.exec(cmdText);
      if (cmd) {
        const name = cmd[1];
        const kind = resolveKind(name, "command");
        const inv: Invocation = { name, kind, sessionId, file, lineNo, timestamp: lineTs };
        if (lineTs && obj) {
          const ev = buildEvent(obj, `${sessionId}:${lineTs}:${name}`, lineTs, kind, name, "typed", sessionId);
          inv.event = ev;
          events.push(ev);
        }
        invocations.push(inv);
        recent.push(inv);
      }

      if (line.includes("[Request interrupted") && line.includes('"type":"user"')) {
        for (const inv of recent) {
          if (lineNo - inv.lineNo <= INTERRUPT_WINDOW) {
            interruptedInvocations.add(inv);
            if (inv.event) inv.event.interrupted = true;
          }
        }
      }
      while (recent.length > 0 && lineNo - recent[0].lineNo > INTERRUPT_WINDOW) recent.shift();
    }
  }

  // Agent launches ride the ledger only: the aggregation below feeds the
  // skill/command usage table, and subagent types in `external` would read as
  // uninstalled skills. Keyed (kind, name): a skill and a command sharing a
  // dispatch name keep separate rows, so neither absorbs the other's fires.
  const byAsset = new Map<string, { name: string; kind: AssetKind; invs: Invocation[] }>();
  for (const inv of invocations) {
    if (inv.kind === "agent") continue;
    const key = `${inv.kind}\0${inv.name}`;
    const g = byAsset.get(key);
    if (g) g.invs.push(inv);
    else byAsset.set(key, { name: inv.name, kind: inv.kind, invs: [inv] });
  }

  const toUsage = (name: string, kind: AssetKind, invs: Invocation[]): SkillUsage & { kind: AssetKind } => {
    const stamps = invs
      .map((i) => i.timestamp)
      .filter((t): t is string => !!t)
      .sort();
    return {
      skill: name,
      kind,
      invocations: invs.length,
      // By sessionId, not file: a fire in a subagent transcript belongs to the
      // session that launched the agent, not to a session of its own.
      sessions: new Set(invs.map((i) => i.sessionId)).size,
      firstFired: stamps[0],
      lastFired: stamps[stamps.length - 1],
      interruptedAfter: invs.filter((i) => interruptedInvocations.has(i)).length,
    };
  };

  const installed = new Set(skills.map((s) => s.dirName));
  const usage: SkillUsage[] = [];
  const external: SkillUsage[] = [];
  for (const { name, kind, invs } of byAsset.values()) {
    (installed.has(name) ? usage : external).push(toUsage(name, kind, invs));
  }
  usage.sort((a, b) => b.invocations - a.invocations);
  external.sort((a, b) => b.invocations - a.invocations);

  // Sorted on every axis: these arrays are compared run-to-run for
  // idempotency, so their order must never depend on which transcript the
  // walk happened to open first.
  const fileReads = [...readsByFile.values()]
    .map((r) => ({ dir: r.dir, relPath: r.relPath, sessions: [...r.sessions].sort() }))
    .sort((a, b) => (a.dir === b.dir ? (a.relPath < b.relPath ? -1 : 1) : a.dir < b.dir ? -1 : 1));
  // Only agents whose transcript actually carried usage records. An agent
  // whose transcript was purged, or truncated before its first response, has
  // no cost on record — and a 0 here would be indistinguishable from a run
  // that genuinely cost nothing. The join compares this against the launch
  // events to say how many runs it could price.
  const agentRuns = [...agentTokens.entries()]
    .map(([agentId, tokens]) => ({ agentId, tokens }))
    .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));

  return {
    transcriptFiles: files.length,
    windowStart,
    windowEnd,
    usage,
    neverFired: skills
      .filter((s) => !byAsset.has(`${s.kind ?? "skill"}\0${s.dirName}`))
      .map((s) => s.dirName)
      .sort(),
    external,
    events,
    fileReads,
    agentRuns,
  };
}
