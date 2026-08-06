#!/usr/bin/env node
// Unit corpus for Claude event extraction (src/history.ts):
//   - recursive walk incl. <session>/subagents/ and subagents/workflows/
//   - one LedgerEvent per invocation: Skill/Agent/Task tool_use + typed commands
//   - outcome tri-state (ok / error / rejected), interrupt attribution, model,
//     entrypoint, caller, agent {id,type}, project, src pointers
//   - aggregation derived from events without regressing SkillUsage shape
//   - nothing content-bearing (args, prompts) ever leaves the transcript
// Fixtures are COPIED into a mkdtemp dir before scanning — the real $HOME is
// never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { historyFacts } = await import(pathToFileURL(join(root, "dist", "history.js")).href);
const { openLedger, isLedgerEvent, LEDGER_SCHEMA_VERSION } = await import(
  pathToFileURL(join(root, "dist", "ledger.js")).href
);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

const tmp = mkdtempSync(join(tmpdir(), "context-audit-history-"));
cpSync(join(root, "test", "fixtures", "history", "projects"), join(tmp, "projects"), { recursive: true });

// Only dirName and kind are read; the rest is inventory ballast.
const skill = (dirName, kind) => ({ dirName, dir: `/x/${dirName}`, body: "", files: [], hasSkillMd: true, kind });
const skills = [
  skill("impeccable", "skill"),
  skill("deploy-check", "command"),
  skill("superpowers:brainstorming", "skill"),
  skill("unused-skill", "skill"),
  // One dispatch name installed as BOTH a skill and a command — the channel
  // decides which row a fire lands on, never discovery order.
  skill("review", "skill"),
  skill("review", "command"),
];

const h = await historyFacts(join(tmp, "projects"), skills);
const byId = new Map((h.events ?? []).map((e) => [e.id, e]));
const usageOf = (name, kind) => h.usage.find((u) => u.skill === name && (kind === undefined || u.kind === kind));
const usage = new Map(h.usage.map((u) => [u.skill, u]));

// --- window + file walk -----------------------------------------------------
console.log("WALK + WINDOW:");
check("all four transcripts found (main, subagents/, workflows/, second session)", h.transcriptFiles === 4, String(h.transcriptFiles));
check("windowStart is the oldest line", h.windowStart === "2026-07-01T10:00:00.000Z", h.windowStart);
check("windowEnd is the newest line", h.windowEnd === "2026-07-02T09:05:00.000Z", h.windowEnd);

// --- aggregation (must not regress) ----------------------------------------
console.log("AGGREGATION:");
{
  const imp = usage.get("impeccable");
  check("impeccable counts main + sidechain + id-less fires", imp?.invocations === 5, JSON.stringify(imp));
  check("sidechain fires collapse into the launching session", imp?.sessions === 1, String(imp?.sessions));
  check("interrupt attributed inside the 15-line window only", imp?.interruptedAfter === 1, String(imp?.interruptedAfter));
  check("first/last fired span the window", imp?.firstFired === "2026-07-01T10:00:00.000Z" && imp?.lastFired === "2026-07-01T10:24:00.000Z");
  const dep = usage.get("deploy-check");
  check("typed + malformed-line + sidechain command all counted", dep?.invocations === 3, JSON.stringify(dep));
  check("usage sorted by invocations", h.usage[0].skill === "impeccable" && h.usage[1].skill === "deploy-check");
  check("usage rows carry their resolved kind", imp?.kind === "skill" && dep?.kind === "command");
  check("external holds the uninstalled typed name", h.external.length === 1 && h.external[0].skill === "ghost-cmd" && h.external[0].invocations === 1);
  check("neverFired lists only the silent skill", JSON.stringify(h.neverFired) === '["unused-skill"]', JSON.stringify(h.neverFired));
  const names = [...h.usage, ...h.external].map((u) => u.skill);
  check("agent launches never pollute usage/external", !names.includes("code-reviewer") && !names.includes("general-purpose"), JSON.stringify(names));

  // A name installed as both skill and command: the dispatch channel splits
  // the fires; last-wins discovery must never pool them on one row.
  const revSkill = usageOf("review", "skill");
  const revCmd = usageOf("review", "command");
  check("shared name: Skill tool_use lands on the skill row", revSkill?.invocations === 1, JSON.stringify(revSkill));
  check("shared name: typed command lands on the command row", revCmd?.invocations === 1, JSON.stringify(revCmd));
}

// --- events: one per invocation --------------------------------------------
console.log("EVENTS:");
{
  check("one event per invocation with a parseable line and a tool_use id", (h.events ?? []).length === 12, String(h.events?.length));
  check("every event passes the ledger shape gate", (h.events ?? []).every((e) => isLedgerEvent(e)));

  const a = byId.get("s1:toolu_A");
  check("Skill tool_use → auto event keyed session:toolUseId", !!a && a.channel === "auto" && a.kind === "skill" && a.name === "impeccable");
  check("event carries schema version", a?.v === LEDGER_SCHEMA_VERSION);
  check("ok outcome from toolUseResult.success", a?.outcome === "ok");
  check("model, entrypoint, caller, project captured", a?.model === "claude-fable-5" && a?.entrypoint === "cli" && a?.caller === "direct" && a?.project === "/work/proj");
  check("src points at the transcript line", a?.src?.file?.endsWith("s1.jsonl") && a?.src?.line === 1, JSON.stringify(a?.src));
  check("main-thread event has no agent attribution", a?.agent === undefined);

  const t = byId.get("s1:2026-07-01T10:01:00.000Z:deploy-check");
  check("typed command → typed event keyed session:ts:name", !!t && t.channel === "typed" && t.name === "deploy-check");
  check("typed name resolves kind from the inventory", t?.kind === "command");
  check("typed command carries no outcome", t?.outcome === undefined);
  const g = byId.get("s1:2026-07-01T10:02:00.000Z:ghost-cmd");
  check("uninstalled typed name defaults to kind command", g?.kind === "command" && g?.name === "ghost-cmd");

  const b = byId.get("s1:toolu_B");
  check("plugin-namespaced dispatch name kept verbatim", b?.name === "superpowers:brainstorming");
  check("success:false → error outcome", b?.outcome === "error");
  const c = byId.get("s1:toolu_C");
  check('literal "User rejected tool use" → rejected, not error', c?.outcome === "rejected");

  const d = byId.get("s1:toolu_D");
  check("Agent tool_use → kind agent named by subagent_type", d?.kind === "agent" && d?.name === "code-reviewer" && d?.channel === "auto");
  check("result without a success key is not an error", d?.outcome === "ok", d?.outcome);
  const e = byId.get("s1:toolu_E");
  check("<synthetic> model is skipped", !!e && e.model === undefined);
  check("interrupt within the window marks the event", e?.interrupted === true);
  check("no result line → outcome absent, never fabricated", e?.outcome === undefined);

  const s1 = byId.get("s1:toolu_S1");
  check("sidechain Skill event carries agent {id,type} from the line", s1?.agent?.id === "abc123" && s1?.agent?.type === "code-reviewer");
  check("sidechain event keeps the parent sessionId", s1?.sessionId === "s1");
  const w = byId.get("s1:toolu_W1");
  check("workflows/ file falls back to path-derived session + agent id", w?.sessionId === "s1" && w?.agent?.id === "def456", JSON.stringify(w?.agent));
  check("auto-fired command resolves kind from the inventory", w?.kind === "command" && w?.caller === "agent");
  const task = byId.get("s2:toolu_T1");
  check('"Task" launcher matched like "Agent"', task?.kind === "agent" && task?.name === "general-purpose");
  check("entrypoint separates automation from interactive", task?.entrypoint === "sdk-cli");

  // Shared dispatch name: each channel's event is stamped with ITS kind.
  const rs = byId.get("s2:toolu_R1");
  check("shared name: auto event keeps kind skill", rs?.kind === "skill" && rs?.name === "review" && rs?.channel === "auto");
  const rc = byId.get("s2:2026-07-02T09:03:00.000Z:review");
  check("shared name: typed event keeps kind command", rc?.kind === "command" && rc?.channel === "typed");
}

// --- forged markers never count (typed = genuine user turns only) -----------
console.log("FORGED MARKERS:");
{
  const all = h.events ?? [];
  check("assistant text quoting <command-name> forges no invocation", usage.get("deploy-check")?.invocations === 3);
  check("assistant text quoting <command-name> forges no event", !all.some((e) => e.ts === "2026-07-01T10:22:00.000Z"));
  check("tool_result quoting <command-name> forges no event", !all.some((e) => e.ts === "2026-07-01T10:23:00.000Z"));
  check("genuine typed turn still yields its event", byId.has("s1:2026-07-01T10:01:00.000Z:deploy-check"));
}

// --- id-less tool_use: counted, never banked --------------------------------
console.log("ID-LESS TOOL_USE:");
{
  const impEvents = (h.events ?? []).filter((e) => e.name === "impeccable");
  check("id-less Skill block counts as an invocation", usage.get("impeccable")?.invocations === 5);
  check("id-less Skill block yields no ledger event", impEvents.length === 4, String(impEvents.length));
}

// --- args-shaped names refused at the source --------------------------------
console.log("NAME GATE:");
{
  const all = h.events ?? [];
  check("args-shaped skill name yields no event", !all.some((e) => e.id.includes("toolu_R2")));
  check("args-shaped subagent_type yields no event", !all.some((e) => e.id.includes("toolu_R3")));
  check("args-shaped names never reach usage or external", ![...h.usage, ...h.external].some((u) => u.skill.includes(" ")));
  check("no event name carries whitespace", all.every((e) => !/\s/.test(e.name)));
}

// --- content never leaks ----------------------------------------------------
console.log("CONTENT:");
{
  check("skill args and prompts never enter the facts", !JSON.stringify(h).includes("SECRET-ARG"));
  const allowed = new Set(["v", "id", "ts", "provider", "kind", "name", "channel", "outcome", "interrupted", "sessionId", "project", "agent", "model", "entrypoint", "caller", "src", "backfill"]);
  check("events carry only schema fields", (h.events ?? []).every((e) => Object.keys(e).every((k) => allowed.has(k))));
}

// --- ledger round-trip + determinism ---------------------------------------
console.log("LEDGER ROUND-TRIP + DETERMINISM:");
{
  const base = mkdtempSync(join(tmpdir(), "context-audit-history-ledger-"));
  const r1 = openLedger(base).appendEvents(h.events ?? []);
  check("all events append to the ledger", r1.appended === 12 && r1.skipped === 0, JSON.stringify(r1));
  const r2 = openLedger(base).appendEvents(h.events ?? []);
  check("a second scan is a no-op (dedupe ids hold)", r2.appended === 0 && r2.skipped === 12, JSON.stringify(r2));
  rmSync(base, { recursive: true, force: true });

  const h2 = await historyFacts(join(tmp, "projects"), skills);
  check("two runs produce byte-identical facts", JSON.stringify(h) === JSON.stringify(h2));

  const empty = await historyFacts(join(tmp, "no-such-dir"), skills);
  check("missing transcripts dir → zero files, empty events", empty.transcriptFiles === 0 && Array.isArray(empty.events) && empty.events.length === 0);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall history checks passed");
process.exit(failures ? 1 : 0);
