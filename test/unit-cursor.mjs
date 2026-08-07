#!/usr/bin/env node
// Unit corpus for Cursor rule usage (src/sources/cursordb.ts + cursor.ts).
//
// Cursor's store is the only source in this codebase that is a DATABASE, and
// the only one whose schema is undocumented, unversioned, and — on the
// reference machine — unobservable: all 1,548 recorded `cursorRules` arrays are
// empty there, so the element shape is a guess. Everything below exists because
// a guess that turns out wrong must produce a STATED unknown, never a smaller
// number presented as a total:
//   - three plausible element shapes all parse; a fourth is counted as unparsed
//     and said out loud in a caveat
//   - a literal `null` value row (real; JSON.parse RETURNS null on it) counts
//     as malformed rather than vanishing
//   - workspace attribution reports "2 of 3", never rounds up
//   - a rule attachment is channel "load", never "auto": Cursor puts the rule
//     in front of the model, it does not dispatch it
//   - every event is dated by its CONVERSATION's createdAt, the only timestamp
//     the store has
//   - an absent store, an unreadable one, and a readable-but-empty one are
//     three different answers, and only the last one is a zero
//
// The store fixture is BUILT by test/fixtures/cursor/build.mjs rather than
// checked in as a binary: a fixture nobody can read is a fixture nobody can
// correct. Everything runs against mkdtemp homes — the real Cursor store on
// this machine is never opened.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = await import(pathToFileURL(join(root, "test", "fixtures", "cursor", "build.mjs")).href);
const cursordbUrl = pathToFileURL(join(root, "dist", "sources", "cursordb.js")).href;
const { cursorStorePath, cursorUserDir, readCursorStore } = await import(cursordbUrl);
const { cursorAdapter } = await import(pathToFileURL(join(root, "dist", "sources", "cursor.js")).href);
const { LEDGER_SCHEMA_VERSION, isLedgerEvent } = await import(pathToFileURL(join(root, "dist", "ledger.js")).href);

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
  const d = mkdtempSync(join(tmpdir(), `context-audit-cursor-${label}-`));
  tmps.push(d);
  return d;
};
const has = (lines, needle) => lines.some((l) => l.includes(needle));

// node:sqlite is feature-gated below Node 22.13 / 23.4. Where it is absent the
// store-backed groups SKIP, loudly and by name — a suite that quietly passed
// would report a green Cursor parser on a runtime that cannot read one byte of
// a Cursor store.
let sqliteAvailable = true;
try {
  await import("node:sqlite");
} catch {
  sqliteAvailable = false;
}

// The project side needs no database: two rules, one of which the store attaches.
const cwd = build.buildProject(freshDir("proj"));
const assets = cursorAdapter.discover({ home: freshDir("discover-home"), cwd });
check(
  "discover finds both project rules, injection classified from frontmatter",
  assets.length === 2 &&
    assets.every((a) => a.source === "cursor" && a.kind === "rule") &&
    assets.find((a) => a.dirName === "typescript")?.injection === "body" &&
    assets.find((a) => a.dirName === "unused")?.injection === "description",
  JSON.stringify(assets.map((a) => [a.dirName, a.injection]))
);

// --- degradation: no store at all -------------------------------------------
// Runs on every runtime, sqlite or not: this is the path that must never throw.
console.log("ABSENT STORE (no readable history ≠ no usage):");
{
  const home = freshDir("absent");
  check("an injected home with no Cursor dir resolves to no user dir", cursorUserDir(home) === undefined);
  check(
    "…and to no store path — the REAL store on this machine is never probed",
    cursorStorePath(home) === undefined
  );
  let facts;
  let threw;
  try {
    facts = await readCursorStore(home);
  } catch (err) {
    threw = err;
  }
  check("reading an absent store does not throw", threw === undefined, String(threw));
  check("it reports not-readable with no invented counters", facts?.readable === false && facts?.attachments.length === 0);
  check(
    "and no `unreadable` reason — there was no store to fail at",
    facts?.unreadable === undefined && facts?.storePath === undefined,
    JSON.stringify(facts)
  );

  const usage = await cursorAdapter.usage({ home, cwd }, assets);
  check("usage() returns no rows", usage.usage.length === 0 && usage.external.length === 0);
  check(
    "neverFired is EMPTY, not the rule list — nothing was measured, so nothing is claimed",
    usage.neverFired.length === 0,
    JSON.stringify(usage.neverFired)
  );
  check("transcriptFiles is 0 and no events are emitted", usage.transcriptFiles === 0 && usage.events === undefined);
  const caveats = cursorAdapter.caveats({ home, cwd });
  check(
    "the caveat says so in words, and refuses the zero reading",
    has(caveats, "no Cursor conversation store was found") && has(caveats, "not a claim that the rules never applied"),
    JSON.stringify(caveats)
  );
}

// --- degradation: a store that will not read --------------------------------
// Also runtime-independent: on Node < 22.13 the reason is the missing module,
// above it the file is not a database. Both are "unreadable", never "zero".
console.log("UNREADABLE STORE:");
{
  const home = build.buildGarbage(freshDir("garbage"));
  check("the store path IS found (the file exists)", typeof cursorStorePath(home) === "string");
  let facts;
  let threw;
  try {
    facts = await readCursorStore(home);
  } catch (err) {
    threw = err;
  }
  check("reading it does not throw", threw === undefined, String(threw));
  check(
    "it degrades to not-readable WITH a stated reason",
    facts?.readable === false && typeof facts?.unreadable === "string" && facts.unreadable.length > 0,
    JSON.stringify(facts)
  );
  const usage = await cursorAdapter.usage({ home, cwd }, assets);
  check(
    "usage claims nothing at all — no rows, no neverFired, no events",
    usage.usage.length === 0 && usage.external.length === 0 && usage.neverFired.length === 0 && usage.events === undefined
  );
  const caveats = cursorAdapter.caveats({ home, cwd });
  check(
    "the caveat names the failure and refuses the zero reading",
    has(caveats, "cursor history unavailable") && has(caveats, "which is not zero usage"),
    JSON.stringify(caveats)
  );
}

if (!sqliteAvailable) {
  console.error(
    `  SKIP: node:sqlite is unavailable on ${process.version} (needs 22.13+ / 23.4+); ` +
      "the Cursor store fixture cannot be built, so every store-backed group below is skipped."
  );
  ok(`store-backed cursor groups (skipped: node:sqlite unavailable on ${process.version}, needs 22.13+/23.4+)`);
} else {
  const home = await build.build(freshDir("store"));
  const ctx = { home, cwd };
  const facts = await readCursorStore(home);

  console.log("READ-ONLY BY CONSTRUCTION:");
  {
    // This tool measures. A scan must never be able to write to a store the
    // user's editor is holding open — not the file, and not a -wal/-journal
    // sidecar next to it.
    const gs = join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
    const before = readdirSync(gs).sort();
    const st = statSync(join(gs, "state.vscdb"));
    await readCursorStore(home);
    const after = readdirSync(gs).sort();
    const st2 = statSync(join(gs, "state.vscdb"));
    check(
      "reading the store leaves no new file beside it",
      JSON.stringify(before) === JSON.stringify(after),
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`
    );
    check(
      "…and does not touch the store's own bytes or mtime",
      st.size === st2.size && st.mtimeMs === st2.mtimeMs
    );
  }

  console.log("STORE READ:");
  check("the store reads", facts.readable === true && facts.unreadable === undefined, JSON.stringify(facts.unreadable));
  check("both conversations are counted", facts.composers === 2, `composers=${facts.composers}`);
  check(
    "7 message records carrying cursorRules are examined across BOTH tables",
    facts.bubbles === 7,
    `bubbles=${facts.bubbles}`
  );
  check(
    "the window is the whole recorded createdAt range, not the range of records that happened to hit",
    facts.windowStart === "2026-03-02T00:00:00.000Z" && facts.windowEnd === "2026-06-18T00:00:00.000Z",
    `${facts.windowStart} .. ${facts.windowEnd}`
  );

  console.log("ELEMENT SHAPES (the schema is a guess, so every guess is tested):");
  const at = (bubbleId, name) => facts.attachments.find((a) => a.bubbleId === bubbleId && a.name === name);
  check("object with `name`", at("b1", "typescript") !== undefined);
  check("object with only `relativePath` — reduced to the basename that joins", at("b2", "testing") !== undefined);
  check("a bare string element", at("b3", "typescript") !== undefined);
  check(
    "two elements in one array, `ruleName` and `name`, both resolve",
    at("b4", "typescript") !== undefined && at("b4", "testing") !== undefined
  );
  check("6 attachments in total, no more and no fewer", facts.attachments.length === 6, JSON.stringify(facts.attachments));
  check(
    "the same (conversation, message) pair recorded in BOTH tables collapses to one attachment",
    facts.attachments.filter((a) => a.bubbleId === "b6").length === 1,
    JSON.stringify(facts.attachments.filter((a) => a.bubbleId === "b6"))
  );
  check(
    "attachments are sorted, so the emitted stream is identical run to run",
    JSON.stringify(facts.attachments.map((a) => `${a.bubbleId}:${a.name}`)) ===
      '["b1:typescript","b2:testing","b3:typescript","b4:testing","b4:typescript","b6:testing"]',
    JSON.stringify(facts.attachments.map((a) => `${a.bubbleId}:${a.name}`))
  );

  console.log("WHAT COULD NOT BE READ IS COUNTED, NOT DROPPED:");
  check(
    "the unrecognizable element is counted as unparsed, never guessed at",
    facts.unparsed === 1,
    `unparsed=${facts.unparsed}`
  );
  check(
    "the literal-null value row is counted as malformed",
    facts.malformed === 1,
    `malformed=${facts.malformed}`
  );
  check(
    "…and the null row is NOT also counted as an examined bubble",
    facts.bubbles === 7 && facts.malformed === 1
  );

  console.log("PROJECT ATTRIBUTION:");
  check("three workspaces walked", facts.workspaces === 3, `workspaces=${facts.workspaces}`);
  check(
    "two of them resolved — the one with no composer list is NOT rounded up",
    facts.workspacesResolved === 2,
    `resolved=${facts.workspacesResolved}`
  );
  check(
    "each conversation lands in its own workspace folder",
    facts.attachments.filter((a) => a.composerId === build.C1).every((a) => a.project === "/Users/dev/alpha") &&
      facts.attachments.filter((a) => a.composerId === build.C2).every((a) => a.project === "/Users/dev/beta"),
    JSON.stringify(facts.attachments.map((a) => a.project))
  );

  console.log("EVENTS:");
  const usage = await cursorAdapter.usage(ctx, assets);
  const events = usage.events ?? [];
  check("one event per attachment", events.length === 6, `${events.length}`);
  check("every event passes the ledger shape gate", events.every((e) => isLedgerEvent(e)));
  check(
    "every event is provider cursor, kind rule, at the current schema version",
    events.every((e) => e.provider === "cursor" && e.kind === "rule" && e.v === LEDGER_SCHEMA_VERSION)
  );
  check(
    "channel is LOAD, never auto — a rule attachment is context the model received, not a dispatch it chose",
    events.every((e) => e.channel === "load"),
    JSON.stringify([...new Set(events.map((e) => e.channel))])
  );
  check(
    "no src pointer — the store is a database, not a line-addressable transcript",
    events.every((e) => e.src === undefined)
  );
  check(
    "the id is composerId:bubbleId:name, content-free and re-derivable",
    events[0].id === `${build.C1}:b1:typescript`,
    events[0].id
  );
  check(
    "sessionId is the conversation id — the ledger's session key for this provider",
    events.every((e) => e.sessionId === e.id.split(":")[0]) &&
      new Set(events.map((e) => e.sessionId)).size === 2
  );
  check(
    "every event in a conversation carries that CONVERSATION's createdAt — bubbles have no timestamp of their own",
    events.filter((e) => e.sessionId === build.C1).every((e) => e.ts === new Date(build.C1_AT).toISOString()) &&
      events.filter((e) => e.sessionId === build.C2).every((e) => e.ts === new Date(build.C2_AT).toISOString()),
    JSON.stringify(events.map((e) => e.ts))
  );
  check(
    "three attachments in one conversation therefore share one date — that is the fact, and the caveats say it",
    new Set(events.filter((e) => e.sessionId === build.C1).map((e) => e.ts)).size === 1
  );

  console.log("USAGE JOIN:");
  check("one store, one transcript file — conversations are not counted here", usage.transcriptFiles === 1);
  check(
    "the window is carried through from the store",
    usage.windowStart === facts.windowStart && usage.windowEnd === facts.windowEnd
  );
  const ts = usage.usage.find((u) => u.skill === "typescript");
  check(
    "the owned rule's row: 3 attachments across 2 conversations",
    usage.usage.length === 1 && ts?.invocations === 3 && ts?.sessions === 2,
    JSON.stringify(usage.usage)
  );
  check(
    "first/last come from the two conversation dates",
    ts?.firstFired === "2026-03-02T00:00:00.000Z" && ts?.lastFired === "2026-06-18T00:00:00.000Z"
  );
  check(
    "a rule this project does not own is EXTERNAL, not folded into its rows",
    usage.external.length === 1 && usage.external[0].skill === "testing" && usage.external[0].invocations === 3,
    JSON.stringify(usage.external)
  );
  check("the installed-but-unattached rule is neverFired", JSON.stringify(usage.neverFired) === '["unused"]');
  check(
    "interruptedAfter is 0 because the schema is silent, and the caveats never claim otherwise",
    usage.usage.every((u) => u.interruptedAfter === 0)
  );

  console.log("CAVEATS (every unknown stated):");
  const caveats = cursorAdapter.caveats(ctx);
  check("the store's provenance and its instability are stated", has(caveats, "undocumented, unversioned SQLite store"));
  check(
    "the per-conversation dating is stated as a limitation of the schema",
    has(caveats, "no per-message timestamp")
  );
  check(
    "the unparsed element is surfaced, not silently dropped",
    has(caveats, "1 recorded cursor rule reference(s) carried no name"),
    JSON.stringify(caveats)
  );
  check("the malformed record is surfaced", has(caveats, "1 cursor record(s) held no readable JSON object"));
  check(
    "attribution reports the ratio it achieved: 2 of 3",
    has(caveats, "resolved 2 of 3 cursor workspace(s)"),
    JSON.stringify(caveats)
  );
  check(
    "nothing claims a failure that did not happen",
    !has(caveats, "cursor history unavailable") && !has(caveats, "no rule attachments are recorded"),
    JSON.stringify(caveats)
  );

  console.log("DETERMINISM:");
  const again = await cursorAdapter.usage(ctx, assets);
  check("a second read emits byte-identical events", JSON.stringify(again.events) === JSON.stringify(events));

  console.log("READABLE BUT EMPTY (a measured zero, with its denominator):");
  {
    const eh = await build.buildEdge(freshDir("edge"));
    const ectx = { home: eh, cwd };
    const ef = await readCursorStore(eh);
    check("the store reads", ef.readable === true);
    check("no attachment survives dating", ef.attachments.length === 0);
    check(
      "the conversation whose createdAt is a SECONDS value is rejected and counted undated",
      ef.undated === 1,
      `undated=${ef.undated}`
    );
    check(
      "…so it never defines the window either",
      ef.windowStart === "2026-06-18T00:00:00.000Z" && ef.windowEnd === "2026-06-18T00:00:00.000Z",
      `${ef.windowStart} .. ${ef.windowEnd}`
    );
    check(
      "a conversation-level rule is counted separately from per-message attachments",
      ef.conversationOnly === 1,
      `conversationOnly=${ef.conversationOnly}`
    );
    check(
      "a `name` holding rule TEXT and a non-array `cursorRules` are both unparsed, never truncated into a name",
      ef.unparsed === 2 && ef.attachments.length === 0,
      `unparsed=${ef.unparsed}`
    );
    const eu = await cursorAdapter.usage(ectx, assets);
    check(
      "THIS zero is a measurement: neverFired lists both installed rules",
      JSON.stringify(eu.neverFired) === '["typescript","unused"]',
      JSON.stringify(eu.neverFired)
    );
    check("…which the absent-store case refused to do — absent ≠ 0", eu.neverFired.length === 2);
    const ec = cursorAdapter.caveats(ectx);
    check(
      "the zero carries its denominator",
      has(ec, "no rule attachments are recorded in 2 cursor conversation(s)"),
      JSON.stringify(ec)
    );
    check("the two unreadable references are stated", has(ec, "2 recorded cursor rule reference(s) carried no name"));
    check("the undated drop is stated", has(ec, "1 cursor rule attachment(s) belong to conversations with no usable createdAt"));
    check("the conversation-level record is stated", has(ec, "1 cursor conversation(s) record rules only at conversation level"));
  }

  console.log("SHAPE SURPRISE (a partial count is an unknown count):");
  {
    const wh = await build.buildWrongShape(freshDir("wrong"));
    const wf = await readCursorStore(wh);
    check("a real SQLite file with the wrong schema degrades rather than throwing", wf.readable === false);
    check("the reason names the shape", /expected shape/.test(wf.unreadable ?? ""), wf.unreadable);
    check(
      "every counter collected before the surprise is invalidated, window included",
      wf.composers === 0 &&
        wf.bubbles === 0 &&
        wf.unparsed === 0 &&
        wf.malformed === 0 &&
        wf.undated === 0 &&
        wf.conversationOnly === 0 &&
        wf.workspaces === 0 &&
        wf.workspacesResolved === 0 &&
        wf.windowStart === undefined &&
        wf.windowEnd === undefined,
      JSON.stringify(wf)
    );
  }

  console.log("WARNING HYGIENE:");
  {
    // node:sqlite emits an ExperimentalWarning at IMPORT time. A CLI that prints
    // it has told the user their audit is broken. Checked in a CHILD process
    // because this one already imported node:sqlite to build the fixture.
    const scratch = freshDir("warn");
    const script = join(scratch, "read.mjs");
    writeFileSync(
      script,
      `const { readCursorStore } = await import(${JSON.stringify(cursordbUrl)});\n` +
        `const f = await readCursorStore(${JSON.stringify(home)});\n` +
        `process.stdout.write(String(f.attachments.length));\n`
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    check(
      "reading the store in a fresh process prints nothing on stderr",
      r.status === 0 && r.stdout === "6" && (r.stderr ?? "") === "",
      `exit ${r.status} out=${JSON.stringify(r.stdout)} err=${JSON.stringify(r.stderr)}`
    );
  }
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall cursor checks passed");
process.exit(failures ? 1 : 0);
