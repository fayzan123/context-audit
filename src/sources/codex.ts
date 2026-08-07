import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { findJsonlFiles, TS_RE } from "../history.js";
import { LEDGER_SCHEMA_VERSION } from "../ledger.js";
import type { HistoryFacts, LedgerEvent, Skill, SkillUsage } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";
import { fileAsset, mdFilesUnder } from "../skills.js";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Codex rollout files record user turns as JSON lines. A prompt fires as a
 * slash command inside the user's text, so the honest signal available is
 * "/name appeared in a user line" — counted per line, attributed per file
 * (one rollout file = one session). Model output is excluded: an assistant
 * merely *mentioning* /ship must not count as the user invoking it.
 */
function isUserLine(line: string): boolean {
  return line.includes('"role":"user"') || line.includes('"user_message"');
}

/** The synthetic user message Codex injects when it loads an AGENTS.md. */
const AGENTS_LOAD_PREFIX = "# AGENTS.md instructions for ";

/**
 * Harness-injected user messages. They ride in `role:"user"` records but are
 * not the user typing, so they never become typed-channel events.
 */
const SYNTHETIC_PREFIXES = [AGENTS_LOAD_PREFIX, "<environment_context>", "<user_instructions>"];

/** A path segment followed by /SKILL.md — the segment is the skill's dir name. */
const SKILL_PATH_RE = /([^\s"'`\\/]+)\/SKILL\.md/g;

/**
 * A plausible on-disk skill directory name. Rollouts also carry SKILL.md paths
 * inside scaffolding commands ("cwc-<slug>/SKILL.md", "${TMP}/SKILL.md" —
 * observed on this machine); a segment with template or shell characters is
 * authorship of docs/code, not a skill read.
 */
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

function parseLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** First input_text of a rollout user message; undefined for any other record. */
function userInputText(payload: any): string | undefined {
  if (payload?.type !== "message" || payload?.role !== "user") return undefined;
  const first = Array.isArray(payload?.content)
    ? payload.content.find((c: any) => c?.type === "input_text" && typeof c?.text === "string")
    : undefined;
  return first?.text;
}

export const codexAdapter: SourceAdapter = {
  id: "codex",

  detect(ctx) {
    return existsSync(join(ctx.home, ".codex"));
  },

  discover(ctx) {
    const assets: Skill[] = [];
    const agentsMd = join(ctx.home, ".codex", "AGENTS.md");
    if (existsSync(agentsMd) && statSync(agentsMd).isFile()) {
      // Global instructions: the whole body rides along in every session.
      assets.push(fileAsset(agentsMd, "~/.codex/AGENTS.md", "codex", "instructions", "body"));
    }
    for (const f of mdFilesUnder(join(ctx.home, ".codex", "prompts"))) {
      // Prompts are user-invoked slash commands: only the name is listed until
      // one fires, so the name is the always-paid cost.
      const name = f.split("/").pop()!.replace(/\.md$/, "");
      assets.push(fileAsset(f, name, "codex", "prompt", "name-only"));
    }
    return assets;
  },

  async usage(ctx, assets): Promise<HistoryFacts> {
    // Sorted so the emitted event stream is deterministic across filesystems.
    const files = findJsonlFiles(join(ctx.home, ".codex", "sessions")).sort();
    const prompts = assets.filter((a) => a.kind === "prompt");
    const patterns = prompts.map((p) => ({
      name: p.dirName,
      // Boundary on both sides: "/ship please" hits, "path/to/shipment" does not.
      re: new RegExp(`(?:^|[\\s"'\`(:])/${escapeRe(p.dirName)}(?![\\w-])`),
    }));

    let windowStart: string | undefined;
    let windowEnd: string | undefined;
    const hits = new Map<
      string,
      { invocations: number; sessions: Set<string>; firstFired?: string; lastFired?: string }
    >();

    const events: LedgerEvent[] = [];
    const seenIds = new Set<string>();
    // Compaction can replay a record; one pass must still emit each id once.
    const push = (e: LedgerEvent): void => {
      if (seenIds.has(e.id)) return;
      seenIds.add(e.id);
      events.push(e);
    };

    for (const file of files) {
      const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
      let lineNo = 0;
      let sessionId: string | undefined;
      let project: string | undefined;
      const loadedDirs = new Set<string>();
      for await (const line of rl) {
        lineNo++;
        const ts = TS_RE.exec(line)?.[1];
        if (ts) {
          if (!windowStart || ts < windowStart) windowStart = ts;
          if (!windowEnd || ts > windowEnd) windowEnd = ts;
        }

        if (!sessionId && line.includes('"type":"session_meta"')) {
          const p = parseLine(line)?.payload;
          // Events need attribution: a rollout without a session_meta still
          // aggregates below, but emits nothing to the ledger.
          if (typeof p?.id === "string" && p.id && typeof p?.cwd === "string") {
            sessionId = p.id;
            project = p.cwd;
          }
        }
        const sid = sessionId;
        const proj = project;

        if (sid && proj && ts && line.includes(AGENTS_LOAD_PREFIX)) {
          const obj = parseLine(line);
          const text = obj?.type === "response_item" ? userInputText(obj.payload) : undefined;
          if (text?.startsWith(AGENTS_LOAD_PREFIX)) {
            const dir = text.slice(AGENTS_LOAD_PREFIX.length).split("\n", 1)[0].trim();
            // One load event per session per file, keyed by the dir the
            // harness announced — the reading provider is codex, never
            // "agents-md".
            if (dir && !loadedDirs.has(dir)) {
              loadedDirs.add(dir);
              push({
                v: LEDGER_SCHEMA_VERSION,
                id: `${sid}:${dir}`,
                ts,
                provider: "codex",
                kind: "instructions",
                name: dir,
                channel: "load",
                sessionId: sid,
                project: proj,
                src: { file, line: lineNo },
              });
            }
          }
        }

        if (
          sid &&
          proj &&
          ts &&
          line.includes("SKILL.md") &&
          (line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"'))
        ) {
          const obj = parseLine(line);
          const p = obj?.type === "response_item" ? obj.payload : undefined;
          const isCall = p?.type === "function_call" || p?.type === "custom_tool_call";
          // apply_patch WRITES files: a SKILL.md inside a patch is authorship,
          // not use. Tool outputs never reach here — only the call's own args.
          if (isCall && p.name !== "apply_patch") {
            const args = [p.arguments, p.input].filter((a: unknown): a is string => typeof a === "string").join("\n");
            const callId = typeof p.call_id === "string" && p.call_id ? p.call_id : ts;
            for (const m of args.matchAll(SKILL_PATH_RE)) {
              if (!SKILL_NAME_RE.test(m[1])) continue;
              push({
                v: LEDGER_SCHEMA_VERSION,
                id: `${sid}:${callId}:${m[1]}`,
                ts,
                provider: "codex",
                kind: "skill",
                name: m[1],
                channel: "auto",
                sessionId: sid,
                project: proj,
                src: { file, line: lineNo },
              });
            }
          }
        }

        if (!isUserLine(line)) continue;
        // Rollouts mirror each user turn as an event_msg line; only the
        // response_item copy of a real (non-synthetic) turn may become a
        // typed event, or every prompt would count twice.
        let typedTurn: boolean | undefined;
        const isTypedTurn = (): boolean => {
          if (typedTurn === undefined) {
            const obj = parseLine(line);
            const text = obj?.type === "response_item" ? userInputText(obj.payload) : undefined;
            typedTurn = text !== undefined && !SYNTHETIC_PREFIXES.some((pre) => text.startsWith(pre));
          }
          return typedTurn;
        };
        for (const p of patterns) {
          if (!p.re.test(line)) continue;
          const h = hits.get(p.name) ?? { invocations: 0, sessions: new Set<string>() };
          h.invocations++;
          h.sessions.add(file);
          if (ts && (!h.lastFired || ts > h.lastFired)) h.lastFired = ts;
          if (ts && (!h.firstFired || ts < h.firstFired)) h.firstFired = ts;
          hits.set(p.name, h);
          if (sid && proj && ts && isTypedTurn()) {
            push({
              v: LEDGER_SCHEMA_VERSION,
              id: `${sid}:${ts}:${p.name}`,
              ts,
              provider: "codex",
              kind: "prompt",
              name: p.name,
              channel: "typed",
              sessionId: sid,
              project: proj,
              src: { file, line: lineNo },
            });
          }
        }
      }
    }

    const usage: SkillUsage[] = [...hits.entries()]
      .map(([skill, h]) => ({
        skill,
        invocations: h.invocations,
        sessions: h.sessions.size,
        firstFired: h.firstFired,
        lastFired: h.lastFired,
        // Rollouts don't record interrupts in a parseable way; zero, not a guess.
        interruptedAfter: 0,
      }))
      .sort((a, b) => b.invocations - a.invocations);

    return {
      transcriptFiles: files.length,
      windowStart,
      windowEnd,
      usage,
      neverFired: prompts.map((p) => p.dirName).filter((n) => !hits.has(n)).sort(),
      external: [],
      events,
    };
  },
};
