#!/usr/bin/env node
// Unit corpus for Codex event extraction (src/sources/codex.ts):
//   - AGENTS.md load events: one per session per file, dir-keyed, provider codex
//   - typed /prompt events from response_item user turns only (the event_msg
//     mirror of the same turn and synthetic harness messages never emit)
//   - skill events from SKILL.md paths in tool-call args (apply_patch writes
//     and tool OUTPUTS excluded)
//   - sessionId/project from session_meta; a rollout without one emits nothing
//   - the pre-existing regex aggregation is unchanged by all of the above
// The fixture home is COPIED to a mkdtemp dir; the real $HOME is never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { codexAdapter } = await import(pathToFileURL(join(root, "dist", "sources", "codex.js")).href);
const { isLedgerEvent } = await import(pathToFileURL(join(root, "dist", "ledger.js")).href);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

const home = mkdtempSync(join(tmpdir(), "context-audit-codex-"));
cpSync(join(root, "test", "fixtures", "codex", "home"), home, { recursive: true });
const ctx = { home, cwd: join(home, "proj") };

console.log("DISCOVERY:");
check("detect sees ~/.codex", codexAdapter.detect(ctx));
const assets = codexAdapter.discover(ctx);
check("discover finds the 3 fixture prompts", assets.filter((a) => a.kind === "prompt").length === 3);

const facts = await codexAdapter.usage(ctx, assets);

// --- existing aggregation stays intact -------------------------------------
console.log("AGGREGATION (unchanged behavior):");
check("all 3 rollouts scanned", facts.transcriptFiles === 3);
check("window spans the rollout timestamps", facts.windowStart === "2026-07-01T10:00:00.000Z" && facts.windowEnd === "2026-07-03T08:00:01.000Z", `${facts.windowStart} .. ${facts.windowEnd}`);
const ship = facts.usage.find((u) => u.skill === "ship");
// Line-based counting is the documented aggregation contract: the AGENTS.md
// body mention (x2), the typed turn, its event_msg mirror, and session B.
check("ship counted per matching line", ship?.invocations === 5 && ship?.sessions === 2, JSON.stringify(ship));
check("ship first/last from timestamped lines", ship?.firstFired === "2026-07-01T10:00:01.000Z" && ship?.lastFired === "2026-07-02T09:00:00.000Z");
const review = facts.usage.find((u) => u.skill === "review");
check("review counts the timestampless line too", review?.invocations === 2 && review?.sessions === 1, JSON.stringify(review));
check("neverFired lists the unused prompt", JSON.stringify(facts.neverFired) === '["deploy"]');

// --- emitted ledger events --------------------------------------------------
console.log("EVENTS (shape):");
const events = facts.events ?? [];
check("8 events emitted", events.length === 8, `got ${events.length}: ${events.map((e) => e.id).join(", ")}`);
check("every event passes the ledger shape gate", events.every((e) => isLedgerEvent(e)));
check("every event is provider codex, v1, with a src pointer", events.every((e) => e.provider === "codex" && e.v === 1 && typeof e.src?.file === "string" && e.src.line > 0));

console.log("AGENTS.MD LOADS:");
const loads = events.filter((e) => e.channel === "load");
check("3 load events, kind instructions", loads.length === 3 && loads.every((e) => e.kind === "instructions"));
check("names are the announced dirs, in file order", JSON.stringify(loads.map((e) => e.name)) === '["/proj/alpha","/proj/alpha/sub","/proj/beta"]', JSON.stringify(loads.map((e) => e.name)));
check("re-injected load collapses to one per session per file", loads.filter((e) => e.id === "sess-aaaa:/proj/alpha").length === 1);
check("load id is sessionId:dir", loads[2].id === "sess-cccc:/proj/beta");
check("load ts comes from its own record", loads[0].ts === "2026-07-01T10:00:01.000Z");

console.log("TYPED PROMPTS:");
const typed = events.filter((e) => e.channel === "typed");
check("2 typed events, kind prompt", typed.length === 2 && typed.every((e) => e.kind === "prompt"));
check("typed id is sessionId:ts:name", typed[0].id === "sess-aaaa:2026-07-01T10:00:03.000Z:ship" && typed[1].id === "sess-cccc:2026-07-03T08:00:01.000Z:review");
check("event_msg mirror did not double-emit ship", typed.filter((e) => e.name === "ship").length === 1);
check("synthetic AGENTS.md mention of /ship did not emit", !typed.some((e) => e.ts === "2026-07-01T10:00:01.000Z"));
check("timestampless /review line did not emit", typed.filter((e) => e.name === "review").length === 1);
check("typed src points at the emitting line", typed[0].src.line === 4 && typed[0].src.file.endsWith("rollout-2026-07-01T10-00-00-sess-aaaa.jsonl"));

console.log("SKILL READS:");
const skills = events.filter((e) => e.kind === "skill");
check("3 skill events, channel auto", skills.length === 3 && skills.every((e) => e.channel === "auto"));
check("ids are sessionId:callId:dirName", JSON.stringify(skills.map((e) => e.id)) === '["sess-aaaa:call_1:deploy-check","sess-aaaa:call_2:deploy-check","sess-aaaa:call_4:notes-helper"]', JSON.stringify(skills.map((e) => e.id)));
check("apply_patch SKILL.md write is authorship, not use", !events.some((e) => e.name === "new-skill"));
check("SKILL.md path in a tool OUTPUT does not emit", !events.some((e) => e.name === "output-only"));
check("template/interpolated paths do not emit", !events.some((e) => e.id.includes("call_5")));

console.log("ATTRIBUTION:");
check("rollout without session_meta emits nothing", !events.some((e) => e.src.file.includes("sess-bbbb")));
check("project is the session_meta cwd", events.filter((e) => e.sessionId === "sess-cccc").every((e) => e.project === "/proj/beta") && events.filter((e) => e.sessionId === "sess-aaaa").every((e) => e.project === "/proj/alpha"));

console.log("DETERMINISM:");
const again = await codexAdapter.usage(ctx, assets);
check("second pass emits byte-identical events", JSON.stringify(again.events) === JSON.stringify(events));

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall codex checks passed");
process.exit(failures ? 1 : 0);
