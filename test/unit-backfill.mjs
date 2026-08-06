#!/usr/bin/env node
// Unit corpus for the typed-channel backfill importer (src/backfill.ts):
//   - cleaning rules on the observed pathologies: /usage poller session,
//     glued /status/exit, pasted absolute path, anchor fragment, typo'd
//     skill, real skill with args, multi-line display
//   - built-ins dropped by default, importable via option — but 100%-built-in
//     sessions die either way
//   - sessions with transcript-derived ledger events are excluded whole
//   - args and pastedContents never reach the ledger; re-runs import 0
// The fixture home is COPIED into a mkdtemp dir and every ledger gets an
// injected base — the real $HOME is never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "backfill");
const { openLedger } = await import(pathToFileURL(join(root, "dist", "ledger.js")).href);
const { runBackfill } = await import(pathToFileURL(join(root, "dist", "backfill.js")).href);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

const tmps = [];
const freshDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
};
const fixtureHome = () => {
  const d = freshDir("context-audit-backfill-home-");
  cpSync(join(fixtures, "home"), d, { recursive: true });
  return d;
};

const inventory = {
  skills: new Set(["impeccable", "brainstorm"]),
  commands: new Set(["plan-review"]),
};

// A transcript-derived (non-backfill) event marks sess-transcript as already
// captured — the importer must skip that session entirely.
const seedTranscriptSession = (led) =>
  led.appendEvents([
    {
      v: 1,
      id: "sess-transcript:tu-1",
      ts: "2026-04-04T11:00:05.000Z",
      provider: "claude",
      kind: "skill",
      name: "impeccable",
      channel: "auto",
      sessionId: "sess-transcript",
      project: "/Users/fx/proj-a",
    },
  ]);

// --- default import: cleaning rules + exclusion ----------------------------
console.log("DEFAULT IMPORT:");
{
  const home = fixtureHome();
  const base = freshDir("context-audit-backfill-led-");
  const led = openLedger(base);
  seedTranscriptSession(led);
  const r = runBackfill(home, led, inventory);

  check("imported count", r.imported === 4, JSON.stringify(r));
  check("built-in in a mixed session dropped", r.droppedBuiltins === 1, String(r.droppedBuiltins));
  check("poller + pure-builtin sessions dropped", r.droppedPollerSessions === 2, String(r.droppedPollerSessions));
  check("unresolved lists the typo once, sorted", JSON.stringify(r.unresolved) === '["impaccable"]', JSON.stringify(r.unresolved));

  const backfilled = led.readEvents().filter((e) => e.backfill);
  check("4 backfill events in the ledger", backfilled.length === 4);
  check("no event from the /usage poller session", !backfilled.some((e) => e.sessionId === "sess-poller"));
  check("no event from the pure-/model session", !backfilled.some((e) => e.sessionId === "sess-model-only"));
  check("captured session excluded whole", !backfilled.some((e) => e.sessionId === "sess-transcript"));
  check("glued /status/exit produced nothing", !backfilled.some((e) => e.name.startsWith("status")));
  check("pasted absolute path produced nothing", !backfilled.some((e) => e.name === "Users"));
  check("anchor fragment produced nothing", !backfilled.some((e) => e.name.startsWith("setup")));
  check("token read from first line only", !backfilled.some((e) => e.name === "brainstorm"));

  const skill = backfilled.find((e) => e.name === "impeccable");
  check("skill token matched to kind skill", skill?.kind === "skill");
  check("channel typed, provider claude, v1", skill?.channel === "typed" && skill?.provider === "claude" && skill?.v === 1);
  check("id is sessionId:ts:name", skill?.id === "sess-mixed:2026-04-02T09:00:00.000Z:impeccable", skill?.id);
  check("epoch-ms timestamp became ISO ts", skill?.ts === "2026-04-02T09:00:00.000Z", skill?.ts);
  check("project taken from the entry", skill?.project === "/Users/fx/proj-a");
  check("src points at history.jsonl line", skill?.src?.file === join(home, ".claude", "history.jsonl") && skill?.src?.line === 4, JSON.stringify(skill?.src));

  const typos = backfilled.filter((e) => e.name === "impaccable");
  check("unmatched token kept with no join, kind command", typos.length === 2 && typos.every((e) => e.kind === "command"));
  const cmd = backfilled.find((e) => e.name === "plan-review");
  check("command token matched to kind command", cmd?.kind === "command" && cmd?.sessionId === "sess-cmd");

  const raw = readFileSync(join(base, "usage", "events-2026-04.jsonl"), "utf8");
  check("skill args never stored", !raw.includes("craft"));
  check("pastedContents never stored", !raw.includes("SECRET-PASTE-BODY") && !raw.includes("pastedContents"));

  // --- idempotency ---------------------------------------------------------
  console.log("RE-RUN:");
  const r2 = runBackfill(home, openLedger(base), inventory);
  check("re-run imports nothing", r2.imported === 0, JSON.stringify(r2));
  check("re-run drop counts unchanged", r2.droppedBuiltins === 1 && r2.droppedPollerSessions === 2);
  check("re-run still names the unresolved token", JSON.stringify(r2.unresolved) === '["impaccable"]');
  check("store still holds 4 backfill events", openLedger(base).readEvents().filter((e) => e.backfill).length === 4);
}

// --- built-ins opt-in ------------------------------------------------------
console.log("INCLUDE BUILT-INS:");
{
  const home = fixtureHome();
  const led = openLedger(freshDir("context-audit-backfill-led-"));
  const r = runBackfill(home, led, inventory, { includeBuiltins: true });
  // +1 for /model in the mixed session, +1 for sess-transcript (no seed here).
  check("built-ins imported on opt-in", r.imported === 6 && r.droppedBuiltins === 0, JSON.stringify(r));
  const model = led.readEvents({ name: "model" });
  check("built-in recorded as kind command", model.length === 1 && model[0].kind === "command" && model[0].sessionId === "sess-mixed");
  check("pure-builtin sessions still dropped under opt-in", r.droppedPollerSessions === 2 && led.readEvents({ sessionId: "sess-model-only" }).length === 0);
  check("unseeded session no longer excluded", led.readEvents({ sessionId: "sess-transcript" }).length === 1);
}

// --- absent history --------------------------------------------------------
console.log("MISSING HISTORY:");
{
  const emptyHome = freshDir("context-audit-backfill-empty-");
  mkdirSync(join(emptyHome, ".claude"), { recursive: true });
  const r = runBackfill(emptyHome, openLedger(freshDir("context-audit-backfill-led-")), inventory);
  check(
    "no history.jsonl means zero everything, no throw",
    r.imported === 0 && r.droppedBuiltins === 0 && r.droppedPollerSessions === 0 && r.unresolved.length === 0,
    JSON.stringify(r)
  );
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall backfill checks passed");
process.exit(failures ? 1 : 0);
