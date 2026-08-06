import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, join, sep } from "node:path";
import { LEDGER_SCHEMA_VERSION } from "./ledger.js";
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
  // inventory says whether that token is a skill or a command, so auto and
  // typed fires of the same asset land under one (kind, name) key.
  const kindByName = new Map<string, AssetKind>();
  for (const s of skills) kindByName.set(s.dirName, s.kind ?? "skill");

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    const pathSession = sessionFromPath(file);
    const pathAgentId = AGENT_FILE_RE.exec(basename(file))?.[1];
    // tool_use id → event, awaiting its tool_result later in the same file.
    const pending = new Map<string, LedgerEvent>();
    let lineNo = 0;
    const recent: Invocation[] = [];

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
      let obj: any;
      if (wantsTool || wantsCmd || hitIds.length > 0) {
        try {
          obj = JSON.parse(line);
        } catch {}
      }
      const lineTs = typeof obj?.timestamp === "string" ? obj.timestamp : ts;
      const sessionId = typeof obj?.sessionId === "string" && obj.sessionId ? obj.sessionId : pathSession;
      const content = obj?.message?.content;

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
        if (tur === "User rejected tool use") ev.outcome = "rejected";
        else if (isErr || (tur && typeof tur === "object" && "success" in tur && tur.success !== true)) ev.outcome = "error";
        else ev.outcome = "ok";
      }

      if (wantsTool && Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_use" || typeof b?.id !== "string") continue;
          let name: string;
          let kind: AssetKind;
          if (b.name === "Skill" && typeof b.input?.skill === "string") {
            // Verbatim dispatch token — plugin:skill namespacing kept.
            name = b.input.skill;
            kind = kindByName.get(name) ?? "skill";
          } else if ((b.name === "Agent" || b.name === "Task") && typeof b.input?.subagent_type === "string") {
            name = b.input.subagent_type;
            kind = "agent";
          } else {
            continue;
          }
          const inv: Invocation = { name, kind, sessionId, file, lineNo, timestamp: lineTs };
          if (lineTs) {
            const ev = buildEvent(obj, `${sessionId}:${b.id}`, lineTs, kind, name, "auto", sessionId, b.caller);
            inv.event = ev;
            pending.set(b.id, ev);
            events.push(ev);
          }
          invocations.push(inv);
          recent.push(inv);
        }
      }

      const cmd = COMMAND_RE.exec(line);
      if (cmd) {
        const name = cmd[1];
        const kind = kindByName.get(name) ?? "command";
        const inv: Invocation = { name, kind, sessionId, file, lineNo, timestamp: lineTs };
        // A typed command on an unparseable line still counts (the regex saw
        // it) — it just cannot yield a ledger event.
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
  // uninstalled skills.
  const bySkill = new Map<string, Invocation[]>();
  for (const inv of invocations) {
    if (inv.kind === "agent") continue;
    bySkill.set(inv.name, [...(bySkill.get(inv.name) ?? []), inv]);
  }

  const toUsage = (name: string, invs: Invocation[]): SkillUsage => {
    const stamps = invs
      .map((i) => i.timestamp)
      .filter((t): t is string => !!t)
      .sort();
    return {
      skill: name,
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
  for (const [name, invs] of bySkill) {
    (installed.has(name) ? usage : external).push(toUsage(name, invs));
  }
  usage.sort((a, b) => b.invocations - a.invocations);
  external.sort((a, b) => b.invocations - a.invocations);

  return {
    transcriptFiles: files.length,
    windowStart,
    windowEnd,
    usage,
    neverFired: skills.map((s) => s.dirName).filter((n) => !bySkill.has(n)).sort(),
    external,
    events,
  };
}
