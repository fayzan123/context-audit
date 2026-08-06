#!/usr/bin/env node
// Unit corpus for the CLI surface (src/index.ts + src/report.ts):
//   - hooks install|uninstall: diff always printed, written only on --yes,
//     refusal on corrupt settings, idempotency both ways
//   - log-event: exits 0 on EVERY input, banks valid payloads, stores no args
//   - backfill: imports the typed channel, drops built-ins/pollers, labels the
//     extended horizon, and re-runs import 0
//   - audit report/--json/--agent: lifetime block beside the window figures,
//     dead-weight line, additive JSON, caveat + degradation on a broken ledger
// Runs the BUILT CLI (dist/index.js) and skips cleanly when dist is absent.
// Every spawn overrides HOME to a mkdtemp copy of a fixture — the real $HOME
// is never read, and CONTEXT_AUDIT_HOME is stripped from the environment.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "index.js");
const fixtures = join(root, "test", "fixtures", "cli");

if (!existsSync(cli)) {
  console.log("skipped: no dist — unit-cli.mjs runs the built CLI (dist/index.js); build first");
  process.exit(0);
}

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
const freshDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `context-audit-cli-${label}-`));
  tmps.push(d);
  return d;
};
const fixtureHome = (name) => {
  const d = freshDir(name);
  cpSync(join(fixtures, name), d, { recursive: true });
  return d;
};
const proj = freshDir("proj"); // empty cwd so no project-level assets leak in

const run = (args, home, opts = {}) => {
  const env = { ...process.env, HOME: home };
  delete env.CONTEXT_AUDIT_HOME;
  try {
    const out = execFileSync("node", [cli, ...args], {
      encoding: "utf8",
      env,
      cwd: opts.cwd ?? proj,
      input: opts.input ?? "",
    });
    return { out, err: "", code: 0 };
  } catch (e) {
    return { out: e.stdout ?? "", err: e.stderr ?? "", code: e.status ?? -1 };
  }
};

const settingsPath = (home) => join(home, ".claude", "settings.json");
const ledgerEvents = (home) => {
  const usage = join(home, ".context-audit", "usage");
  if (!existsSync(usage)) return "";
  return readdirSync(usage)
    .filter((f) => /^events-.*\.jsonl$/.test(f))
    .sort()
    .map((f) => readFileSync(join(usage, f), "utf8"))
    .join("");
};

// --- hooks install / uninstall ----------------------------------------------
console.log("HOOKS (diff-and-confirm flow):");
{
  const home = freshDir("hooks");
  const dry = run(["hooks", "install"], home);
  check("install without --yes exits 0", dry.code === 0, dry.err);
  check("install without --yes prints the diff", dry.out.includes("--- ") && dry.out.includes("+++ ") && dry.out.includes("context-audit log-event --claude-hook PostToolUse"));
  check("install without --yes points at --yes", dry.out.includes("context-audit hooks install --yes"));
  check("install without --yes writes nothing", !existsSync(settingsPath(home)));

  const wet = run(["hooks", "install", "--yes"], home);
  check("install --yes writes and says so", wet.code === 0 && wet.out.includes(`written: ${settingsPath(home)}`), wet.out);
  check("install --yes still prints the diff first", wet.out.includes("--- ") && wet.out.includes("@@ "));
  const s = JSON.parse(readFileSync(settingsPath(home), "utf8"));
  check(
    "two PostToolUse entries and one UserPromptExpansion land",
    s.hooks?.PostToolUse?.length === 2 && s.hooks?.UserPromptExpansion?.length === 1,
    JSON.stringify(s.hooks)
  );

  const bytes = readFileSync(settingsPath(home), "utf8");
  const again = run(["hooks", "install", "--yes"], home);
  check("second install is a stated no-op", again.code === 0 && again.out.includes("nothing to add"), again.out);
  check("second install leaves the file byte-identical", readFileSync(settingsPath(home), "utf8") === bytes);

  const undry = run(["hooks", "uninstall"], home);
  check("uninstall without --yes prints diff, writes nothing", undry.code === 0 && undry.out.includes("@@ ") && readFileSync(settingsPath(home), "utf8") === bytes);
  const unwet = run(["hooks", "uninstall", "--yes"], home);
  check("uninstall --yes removes the hooks key", unwet.code === 0 && !("hooks" in JSON.parse(readFileSync(settingsPath(home), "utf8"))));
  const unAgain = run(["hooks", "uninstall", "--yes"], home);
  check("second uninstall is a stated no-op", unAgain.code === 0 && unAgain.out.includes("nothing to remove"), unAgain.out);
}
{
  const home = fixtureHome("corrupt-home");
  const before = readFileSync(settingsPath(home), "utf8");
  const r = run(["hooks", "install", "--yes"], home);
  check("corrupt settings refuse with exit 2", r.code === 2, `code ${r.code}`);
  check("refusal names the problem on stderr", r.err.includes("not valid JSON"), r.err);
  check("refusal leaves the file untouched", readFileSync(settingsPath(home), "utf8") === before);

  check("hooks without an action is a usage error", run(["hooks"], home).code === 2);
  check("hooks with an unknown action is a usage error", run(["hooks", "frobnicate"], home).code === 2);
}

// --- log-event ---------------------------------------------------------------
console.log("LOG-EVENT (hook target — exits 0 no matter what):");
{
  const home = freshDir("logevent");
  const payload = JSON.stringify({
    session_id: "cs1",
    cwd: "/p",
    hook_event_name: "PostToolUse",
    tool_name: "Skill",
    tool_use_id: "tu1",
    tool_input: { skill: "greet", args: "SECRET-ARG do not store" },
  });
  const r1 = run(["log-event", "--claude-hook", "PostToolUse"], home, { input: payload });
  check("valid payload exits 0 in silence", r1.code === 0 && r1.out === "", r1.out || r1.err);
  const stored = ledgerEvents(home);
  check("event banked with the transcript-convergent id", stored.includes('"id":"cs1:tu1"') && stored.includes('"name":"greet"'), stored);
  check("args never reach the ledger", !stored.includes("SECRET"));
  // Append mode: the hook path must not establish the tracking horizon from
  // its own wall clock — meta.json is left for a full open to write.
  check("log-event never writes meta.json", !existsSync(join(home, ".context-audit", "usage", "meta.json")));

  const before = ledgerEvents(home);
  check("malformed stdin exits 0", run(["log-event", "--claude-hook", "PostToolUse"], home, { input: "not { json" }).code === 0);
  check("unknown hook event exits 0", run(["log-event", "--claude-hook", "Stop"], home, { input: payload }).code === 0);
  check("missing --claude-hook exits 0", run(["log-event"], home, { input: payload }).code === 0);
  check("none of those appended anything", ledgerEvents(home) === before);

  const p2 = payload.replace('"tu1"', '"tu2"');
  const r2 = run(["log-event", "--claude-hook", "PostToolUse", "--totally-bogus-flag"], home, { input: p2 });
  check("stray flags never break the hook path", r2.code === 0 && ledgerEvents(home).includes('"id":"cs1:tu2"'), r2.err);

  const broken = freshDir("logevent-broken");
  writeFileSync(join(broken, ".context-audit"), "a file where the dotdir should be\n");
  const r3 = run(["log-event", "--claude-hook", "PostToolUse"], broken, { input: payload });
  check("unwritable ledger still exits 0 in silence", r3.code === 0 && r3.out === "");
}

// --- backfill ----------------------------------------------------------------
console.log("BACKFILL (history.jsonl import):");
{
  const home = fixtureHome("backfill-home");
  const r = run(["backfill"], home);
  check("backfill exits 0", r.code === 0, r.err);
  check("imports the two qualifying events", r.out.includes("imported: 2 typed-command event(s)"), r.out);
  check("names both drop counts", r.out.includes("dropped: 1 all-built-in session(s), 1 built-in command(s)"), r.out);
  check("points at --include-builtins", r.out.includes("--include-builtins"));
  check("lists the unresolved typo", r.out.includes("unresolved") && r.out.includes("impaccable"), r.out);
  check("labels the backfilled typed horizon", r.out.includes("typed-channel history extends to 2026-02-26 (backfilled)"), r.out);
  check("states the model-invoked channel has nothing", r.out.includes("no model-invoked events recorded yet"), r.out);

  const stored = ledgerEvents(home);
  check("greet imported as a skill fire", stored.includes('"name":"greet"') && stored.includes('"kind":"skill"'), stored);
  check("typo imported as a command with no join", stored.includes('"name":"impaccable"') && stored.includes('"kind":"command"'));
  check("pastes and args never reach the ledger", !stored.includes("SECRET-PASTE") && !stored.includes("please"));
  check("built-ins were not imported", !stored.includes('"name":"status"') && !stored.includes('"name":"usage"'));

  const r2 = run(["backfill"], home);
  check("re-run imports 0 (idempotent)", r2.code === 0 && r2.out.includes("imported: 0 typed-command event(s)"), r2.out);

  // Audit over the same home: lifetime block reflects the backfilled events.
  const j = JSON.parse(run(["--json"], home).out);
  const src = j.sources.find((s) => s.source === "claude");
  const lt = src.lifetime;
  check("audit --json carries the backfill horizon", lt?.typedSince === "2026-02-26T00:00:00.000Z", JSON.stringify(lt));
  check("greet fired once, lifetime", lt.fired.length === 1 && lt.fired[0].name === "greet" && lt.fired[0].invocations === 1, JSON.stringify(lt.fired));
  check("unresolved names stay out of the inventory join", !lt.fired.some((u) => u.name === "impaccable"));
  check("nothing dead-weighted when everything tracked has fired", lt.neverFired.length === 0 && lt.deadWeightEstChars === 0);

  const rep = run([], home).out;
  check("report labels the extended typed horizon", rep.includes("typed-channel history extends to 2026-02-26 (backfilled)"), rep);
  check("report surfaces pre-window fires", rep.includes("fired before this window, 0 in it:") && rep.includes("greet × 1 since 2026-02-26"), rep);
}
{
  const home = fixtureHome("backfill-home");
  const r = run(["backfill", "--include-builtins"], home);
  check("--include-builtins imports the built-in too", r.out.includes("imported: 3 typed-command event(s)"), r.out);
  check("the pure poller session still dies", r.out.includes("dropped: 1 all-built-in session(s), 0 built-in command(s)"), r.out);
}
{
  const home = freshDir("nobackfill");
  const r = run(["backfill"], home);
  check("missing history.jsonl is stated, not invented", r.code === 0 && r.out.includes("nothing to import"), r.out);
}

// --- audit: lifetime beside the window ---------------------------------------
console.log("AUDIT (lifetime block from the durable ledger):");
{
  const home = fixtureHome("audit-home");
  const j = JSON.parse(run(["--json"], home).out);
  const src = j.sources.find((s) => s.source === "claude");
  check("window figures unchanged: greet fired once in window", src.history.usage.length === 1 && src.history.usage[0].skill === "greet" && src.history.usage[0].invocations === 1, JSON.stringify(src.history.usage));
  const lt = src.lifetime;
  check("trackedSince comes from the seeded meta", lt?.trackedSince === "2026-03-01T00:00:00.000Z", JSON.stringify(lt));
  const g = lt.fired[0];
  // 4 events: two seeded auto fires, one banked window fire, and one seeded
  // typed event mis-kinded "command" — greet is installed only as a skill, so
  // the join must heal the stored guess onto the skill row.
  check(
    "lifetime merges seeded + banked + kind-healed events",
    lt.fired.length === 1 && g.name === "greet" && g.kind === "skill" && g.invocations === 4 && g.sessions === 4,
    JSON.stringify(lt.fired)
  );
  check("first/last fired span both windows", g.firstFired.startsWith("2026-03-05") && g.lastFired.startsWith("2026-07-01"));
  // Raw events exist to be banked; --json stays additive (report.ts contract)
  // and must never carry session ids, cwds or transcript paths.
  check("--json strips the raw events array after banking", src.history.events === undefined && !JSON.stringify(j).includes('"events":'), Object.keys(src.history).join(","));
  check("idle is never-fired in BOTH windows", lt.neverFired.length === 1 && lt.neverFired[0] === "idle");
  check("dead-weight estimate is the idle listing entry", lt.deadWeightEstChars === 28, String(lt.deadWeightEstChars));
  check("no typedSince without backfilled events", lt.typedSince === undefined);

  // Idempotency: a second run rescans the same transcripts and must not grow counts.
  const j2 = JSON.parse(run(["--json"], home).out);
  check("re-scan does not double-count lifetime", j2.sources[0].lifetime.fired[0].invocations === 4);
  const snaps = readFileSync(join(home, ".context-audit", "usage", "snapshots.jsonl"), "utf8").trim().split("\n");
  check("one snapshot line per CLI run", snaps.length === 2, `${snaps.length} lines`);
  const snap = JSON.parse(snaps[0]);
  check(
    "snapshot states this run's inventory",
    snap.items === 2 && snap.enabled === 2 && snap.byProvider.claude === 2 && snap.injectedChars === src.content.alwaysInjectedChars,
    snaps[0]
  );
  check("snapshot records the budgeted listing figure", typeof snap.listingChars === "number" && snap.listingChars > 0, snaps[0]);

  const rep = run([], home).out;
  check("report names the ledger horizon", rep.includes("durable ledger: tracking since 2026-03-01"), rep);
  check("window line carries the lifetime tail", rep.includes("greet × 1 in 1 session(s), last 2026-07-01 · 4 since 2026-03-01"), rep);
  check("dead-weight line is qualified and estimated", rep.includes("never fired since tracking began 2026-03-01") && rep.includes("~28 chars") && rep.includes("chars/4 estimate"), rep);

  const agent = JSON.parse(run(["--agent"], home).out);
  check("--agent usage carries the same lifetime block", agent.sources[0].usage.lifetime.trackedSince === "2026-03-01T00:00:00.000Z");

  const noHist = JSON.parse(run(["--json", "--no-history"], home).out);
  check("--no-history never opens the ledger", noHist.sources[0].lifetime === undefined && noHist.sources[0].history === undefined);
}
{
  // Broken ledger: figures degrade to window-only WITH a caveat, never a crash.
  const home = fixtureHome("audit-home");
  rmSync(join(home, ".context-audit"), { recursive: true, force: true });
  writeFileSync(join(home, ".context-audit"), "a file where the dotdir should be\n");
  const r = run(["--json"], home);
  const src = JSON.parse(r.out).sources.find((s) => s.source === "claude");
  const caveats = (src.caveats ?? []).filter((c) => c.startsWith("usage ledger unavailable"));
  check("broken ledger degrades with exactly one caveat", r.code === 0 && caveats.length === 1, JSON.stringify(src.caveats));
  check("no lifetime claims without a ledger", src.lifetime === undefined);
  check("window figures survive the degradation", src.history.usage[0].skill === "greet");
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall cli checks passed");
process.exit(failures ? 1 : 0);
