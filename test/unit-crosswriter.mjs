#!/usr/bin/env node
// Cross-writer corpus: the REAL hook writer (src/hooks.ts logEvent) and the
// REAL scan (buildUiPayload) against one shared ledger home — no hand-written
// ledger lines standing in for either writer:
//   - one typed invocation through hook THEN scan lands exactly one typed
//     event in the store (the hook owns the session's typed channel; the
//     transcript-derived copy with its divergent clock id is never banked)
//   - one auto invocation hook-first then scan converges on one event whose
//     hook record was ENRICHED with the transcript's outcome AND src pointer
//   - the hook's append-mode open never writes meta.json; the scan's full
//     open establishes the horizon afterwards
//   - both fires count exactly once on the SKILL row (the hook's provisional
//     kind "command" on the typed event is healed by the join)
//   - a second scan changes nothing: monthly files byte-identical, counts stable
//   - empirical heal: a PRE-FIX poisoned store line {kind:"command",
//     channel:"typed"} for an installed skill counts in that skill's lifetime
// The home and ledgers are mkdtemp dirs; the real $HOME is never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildUiPayload } = await import(pathToFileURL(join(root, "dist", "ui", "inventory.js")).href);
const { logEvent } = await import(pathToFileURL(join(root, "dist", "hooks.js")).href);
const { openLedger } = await import(pathToFileURL(join(root, "dist", "ledger.js")).href);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

const tmp = mkdtempSync(join(tmpdir(), "context-audit-crosswriter-"));
const home = join(tmp, "home");
const cwd = join(home, "proj");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(home, ".claude", "skills", "impeccable"), { recursive: true });
writeFileSync(
  join(home, ".claude", "skills", "impeccable", "SKILL.md"),
  "---\nname: impeccable\ndescription: Craft distinctive, polished frontend interfaces.\n---\n\nDo the frontend work well.\n"
);
// Session id comes from the transcript FILENAME. Line 1 is the typed dispatch
// the hook also captured live; lines 2-3 are the auto fire the hook saw as a
// bare tool_use and the transcript resolves with an outcome.
const projDir = join(home, ".claude", "projects", "-cw-proj");
mkdirSync(projDir, { recursive: true });
const transcript = join(projDir, "sess-cw.jsonl");
writeFileSync(
  transcript,
  [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "<command-name>/impeccable</command-name>\n<command-args></command-args>" },
      uuid: "u1", timestamp: "2026-07-10T12:00:00.000Z", sessionId: "sess-cw", entrypoint: "cli", cwd,
    }),
    JSON.stringify({
      type: "assistant", isSidechain: false,
      message: { role: "assistant", model: "claude-fable-5", content: [{ type: "tool_use", id: "toolu_cw1", name: "Skill", input: { skill: "impeccable" }, caller: { type: "direct" } }] },
      uuid: "u2", timestamp: "2026-07-10T12:01:00.000Z", sessionId: "sess-cw", entrypoint: "cli", cwd,
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cw1", content: "Skill failed to launch", is_error: true }] },
      toolUseResult: { success: false, commandName: "impeccable" },
      uuid: "u3", timestamp: "2026-07-10T12:01:01.000Z", sessionId: "sess-cw", cwd,
    }),
  ].join("\n") + "\n"
);

const hookPayload = (over) => JSON.stringify({ session_id: "sess-cw", cwd, ...over });

console.log("CROSS-WRITER (hook fires live, scan follows):");
{
  const ledgerHome = join(tmp, "ledgerA");
  mkdirSync(ledgerHome, { recursive: true });

  // The hook path, exactly as runLogEvent wires it: append-mode open per fire.
  const hookLedger = openLedger(ledgerHome, { mode: "append" });
  const rTyped = logEvent(
    hookPayload({ hook_event_name: "UserPromptExpansion", command: "/impeccable make it pop" }),
    hookLedger,
    "UserPromptExpansion"
  );
  check("hook banks the typed invocation", rTyped.appended === 1 && rTyped.skipped === 0, JSON.stringify(rTyped));
  const rAuto = logEvent(
    hookPayload({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "impeccable", args: "SECRET-ARG never store me" }, tool_use_id: "toolu_cw1" }),
    hookLedger,
    "PostToolUse"
  );
  check("hook banks the auto invocation", rAuto.appended === 1 && rAuto.skipped === 0, JSON.stringify(rAuto));
  check("hook's append-mode open never writes meta.json", !existsSync(join(ledgerHome, "usage", "meta.json")));
  const preScan = openLedger(ledgerHome).readEvents({ sessionId: "sess-cw" });
  const hookAuto = preScan.find((e) => e.id === "sess-cw:toolu_cw1");
  check(
    "hook's auto record starts poor: no outcome, no src",
    hookAuto !== undefined && hookAuto.outcome === undefined && hookAuto.src === undefined,
    JSON.stringify(hookAuto)
  );

  const p1 = await buildUiPayload({ home, cwd, ledgerHome }, { history: true });
  const all = openLedger(ledgerHome).readEvents();
  check("scan's full open established meta.json", existsSync(join(ledgerHome, "usage", "meta.json")));

  // Typed channel is single-writer: the transcript's copy (divergent clock in
  // the id) must never bank beside the hook's.
  const typed = all.filter((e) => e.channel === "typed" && e.name === "impeccable" && e.sessionId === "sess-cw");
  check("one typed invocation through hook + scan is exactly one ledger event", typed.length === 1, JSON.stringify(typed));
  check("the surviving typed event is the hook's", typed[0]?.hook === true && typed[0]?.kind === "command", JSON.stringify(typed[0]));
  check(
    "the transcript-derived typed id was never banked",
    !all.some((e) => e.id === "sess-cw:2026-07-10T12:00:00.000Z:impeccable"),
    all.map((e) => e.id).join(", ")
  );

  // Auto channel converges on one id, and the scan ENRICHED the hook's record.
  const autos = all.filter((e) => e.id === "sess-cw:toolu_cw1");
  check("one auto invocation hook-first then scan is exactly one event", autos.length === 1, JSON.stringify(autos));
  check("the auto event gained the transcript's outcome", autos[0]?.outcome === "error", JSON.stringify(autos[0]));
  check(
    "the auto event gained the transcript src pointer",
    autos[0]?.src?.file === transcript && autos[0]?.src?.line === 2,
    JSON.stringify(autos[0]?.src)
  );
  check("enrichment kept the hook marker", autos[0]?.hook === true);
  check(
    "no args or prompt text reached the store",
    !readdirSync(join(ledgerHome, "usage")).some((f) =>
      readFileSync(join(ledgerHome, "usage", f), "utf8").includes("SECRET")
    )
  );

  // Both fires land once each on the SKILL row: the hook's provisional
  // "command" kind on the typed event is healed by the join.
  const imp = p1.items.find((i) => i.name === "impeccable");
  check(
    "both fires count exactly once on the skill row",
    imp?.fires?.lifetime?.invocations === 2 && imp?.fires?.byChannel?.typed === 1 && imp?.fires?.byChannel?.auto === 1,
    JSON.stringify(imp?.fires)
  );
  check("the enriched outcome reaches the row", imp?.fires?.outcomes?.error === 1, JSON.stringify(imp?.fires?.outcomes));
  check(
    "window figures still come from the transcript, unexcluded",
    imp?.fires?.invocations === 2 && imp?.fires?.sessions === 1,
    JSON.stringify(imp?.fires)
  );

  // A second scan is a no-op on the store and the numbers.
  const monthly = () =>
    readdirSync(join(ledgerHome, "usage"))
      .filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => f + " " + readFileSync(join(ledgerHome, "usage", f), "utf8"))
      .join("\n");
  const before = monthly();
  const p2 = await buildUiPayload({ home, cwd, ledgerHome }, { history: true });
  const imp2 = p2.items.find((i) => i.name === "impeccable");
  check("second scan leaves the monthly files byte-identical", monthly() === before);
  check(
    "second scan reports the same counts",
    imp2?.fires?.lifetime?.invocations === 2 && imp2?.fires?.byChannel?.typed === 1 && imp2?.fires?.byChannel?.auto === 1,
    JSON.stringify(imp2?.fires)
  );
}

console.log("EMPIRICAL HEAL (pre-fix poisoned store line):");
{
  // A store written BEFORE the join learned to heal: a typed fire of the
  // installed skill banked under kind "command" (the old hook hard-coding).
  const ledgerHome = join(tmp, "ledgerB");
  mkdirSync(join(ledgerHome, "usage"), { recursive: true });
  writeFileSync(
    join(ledgerHome, "usage", "events-2026-03.jsonl"),
    JSON.stringify({
      v: 1, id: "old-sess:2026-03-05T10:00:00.000Z:impeccable", ts: "2026-03-05T10:00:00.000Z",
      provider: "claude", kind: "command", name: "impeccable", channel: "typed",
      sessionId: "old-sess", project: cwd,
    }) + "\n"
  );
  const p = await buildUiPayload({ home, cwd, ledgerHome }, { history: true });
  const imp = p.items.find((i) => i.name === "impeccable");
  check(
    "the poisoned typed event counts in the skill's lifetime",
    imp?.fires?.lifetime?.invocations === 3 && imp?.fires?.byChannel?.typed === 2 && imp?.fires?.byChannel?.auto === 1,
    JSON.stringify(imp?.fires)
  );
  check(
    "lifetime firstFired is the poisoned event's ts — proof it joined",
    imp?.fires?.lifetime?.firstFired === "2026-03-05T10:00:00.000Z",
    JSON.stringify(imp?.fires?.lifetime)
  );
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall crosswriter checks passed");
process.exit(failures ? 1 : 0);
