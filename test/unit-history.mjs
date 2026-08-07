#!/usr/bin/env node
// Unit corpus for Claude event extraction (src/history.ts):
//   - recursive walk incl. <session>/subagents/ and subagents/workflows/
//   - one LedgerEvent per invocation: Skill/Agent/Task tool_use + typed commands
//   - outcome tri-state (ok / error / rejected), interrupt attribution, model,
//     entrypoint, caller, agent {id,type}, project, src pointers
//   - aggregation derived from events without regressing SkillUsage shape
//   - the name gate PER CHANNEL: NAME_RE on skill/command tokens, AGENT_NAME_RE
//     on subagent_type (prose names in, control characters and >80 out)
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
  // Agents are installed under their registered frontmatter name, which is what
  // `subagent_type` carries — so a launch of one you own joins to its row, and
  // one you do not own falls through to `external`.
  skill("LinkedIn Content Creator", "agent"),
  skill("idle-agent", "agent"),
];

const h = await historyFacts(join(tmp, "projects"), skills);
const byId = new Map((h.events ?? []).map((e) => [e.id, e]));
const usageOf = (name, kind) => h.usage.find((u) => u.skill === name && (kind === undefined || u.kind === kind));
const usage = new Map(h.usage.map((u) => [u.skill, u]));

// --- window + file walk -----------------------------------------------------
console.log("WALK + WINDOW:");
check("all four transcripts found (main, subagents/, workflows/, second session)", h.transcriptFiles === 4, String(h.transcriptFiles));
check("windowStart is the oldest line", h.windowStart === "2026-07-01T10:00:00.000Z", h.windowStart);
check("windowEnd is the newest line", h.windowEnd === "2026-07-02T09:09:00.000Z", h.windowEnd);

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
  const ext = (n) => h.external.find((u) => u.skill === n);
  check("external holds the uninstalled typed name", ext("ghost-cmd")?.invocations === 1, JSON.stringify(h.external));
  check(
    "neverFired lists the silent skill AND the silent agent",
    JSON.stringify(h.neverFired) === '["idle-agent","unused-skill"]',
    JSON.stringify(h.neverFired)
  );

  // Agent launches aggregate like every other dispatch. They were held out
  // while nothing could match a subagent type against the inventory; an agent's
  // dirName is its registered frontmatter name, so the match is exact.
  const li = usageOf("LinkedIn Content Creator", "agent");
  check("a launch of an INSTALLED agent lands in usage", li?.invocations === 1 && li?.kind === "agent", JSON.stringify(li));
  check("its timestamps come from the launch line", li?.lastFired === "2026-07-02T09:08:00.000Z", JSON.stringify(li));
  // The harness's own subagent types are installed by nobody, and land where a
  // dispatch naming nothing you own has always landed.
  check("an UNINSTALLED subagent type lands in external", ext("general-purpose")?.invocations === 1 && ext("code-reviewer")?.invocations === 1, JSON.stringify(h.external));
  check("an uninstalled agent name never appears in usage", !h.usage.some((u) => u.skill === "general-purpose" || u.skill === "code-reviewer"));
  check("external rows keep their kind, so a subagent type never reads as a skill", ext("general-purpose")?.kind === "agent" && ext("ghost-cmd")?.kind === "command", JSON.stringify([ext("general-purpose")?.kind, ext("ghost-cmd")?.kind]));

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
  check("one event per invocation with a parseable line and a tool_use id", (h.events ?? []).length === 15, String(h.events?.length));
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

// --- the name gate, per channel ---------------------------------------------
// Two rules, chosen by the event's own kind. A skill or command token comes off
// a line that may carry arguments behind it, so NAME_RE stays the backstop
// there. An agent name arrives as `subagent_type` — a structured parameter the
// harness fills from a registered frontmatter `name:` — and every real one
// ("LinkedIn Content Creator") failed NAME_RE, which is how 110 registerable
// agents came to be unobservable and the one real dispatch on the design
// machine was discarded.
console.log("NAME GATE (per channel):");
{
  const all = h.events ?? [];
  const named = (n) => all.filter((e) => e.name === n);
  check("args-shaped skill name yields no event", !all.some((e) => e.id.includes("toolu_R2")));
  check(
    "the args-shaped name reaches neither usage nor external",
    ![...h.usage, ...h.external].some((u) => u.skill.startsWith("impeccable ")),
    JSON.stringify([...h.usage, ...h.external].map((u) => u.skill))
  );
  check(
    "no skill or command row carries whitespace in its name",
    ![...h.usage, ...h.external].some((u) => u.kind !== "agent" && /\s/.test(u.skill))
  );
  check(
    "no skill or command event name carries whitespace",
    all.filter((e) => e.kind !== "agent").every((e) => !/\s/.test(e.name))
  );

  // Accepted on the agent channel: prose names, and every non-alphanumeric
  // character the 110 real agent names on the design machine actually use.
  const linkedin = named("LinkedIn Content Creator");
  check("a spaced agent name is admitted via Agent", linkedin.length === 1 && linkedin[0].kind === "agent", JSON.stringify(linkedin));
  check("the same name is admitted via the older Task spelling", named("Backend Architect").length === 1);
  const sixty = "Research & Analysis, Ops/Infra, Delivery Coordination Agents";
  check("60 chars with space, &, comma and slash are admitted", sixty.length === 60 && named(sixty).length === 1);

  // Refused on the agent channel: a control character (U+0000 is the usage
  // join-key separator, so a name carrying one could forge a join onto another
  // asset's row) and a name past the 80-character cap.
  check("a control character in subagent_type yields no event", !all.some((e) => e.id.includes("toolu_R3")));
  check("no event name carries a control character", all.every((e) => !/[\u0000-\u001F\u007F]/.test(e.name)));
  check("an 81-character subagent_type yields no event", !all.some((e) => e.id.includes("toolu_R4")));
  check("no event name exceeds the 80-character cap", all.every((e) => e.name.length <= 80));
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
  check("all events append to the ledger", r1.appended === 15 && r1.skipped === 0, JSON.stringify(r1));
  const r2 = openLedger(base).appendEvents(h.events ?? []);
  check("a second scan is a no-op (dedupe ids hold)", r2.appended === 0 && r2.skipped === 15, JSON.stringify(r2));
  // The durable boundary keeps the same split the writers do: an agent's prose
  // name survives a round trip, and every other kind still faces STORE_NAME_RE.
  check(
    "a spaced agent name survives the durable boundary",
    openLedger(base).readEvents({ kind: "agent", name: "LinkedIn Content Creator" }).length === 1
  );
  rmSync(base, { recursive: true, force: true });

  const h2 = await historyFacts(join(tmp, "projects"), skills);
  check("two runs produce byte-identical facts", JSON.stringify(h) === JSON.stringify(h2));

  const empty = await historyFacts(join(tmp, "no-such-dir"), skills);
  check("missing transcripts dir → zero files, empty events", empty.transcriptFiles === 0 && Array.isArray(empty.events) && empty.events.length === 0);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall history checks passed");
process.exit(failures ? 1 : 0);
