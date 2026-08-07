#!/usr/bin/env node
// Unit corpus for the durable usage ledger (src/ledger.ts):
//   - append+dedupe idempotency, in-process and across reopens
//   - duplicate-id ENRICHMENT: later sightings fill missing optional fields,
//     durably, without ever double-counting or overwriting set fields
//   - monthly file routing by event ts, never wall clock
//   - malformed-line tolerance (skipped, counted, never a crash), incl.
//     month-prefixed junk timestamps and args-shaped names
//   - the name rule SPLIT BY KIND at the durable boundary: an agent's prose
//     name is admitted, and the same args-shaped string is still refused on a
//     skill or command event — the privacy boundary NAME_RE exists to hold
//   - append mode: no historical parse at open, per-month id dedupe,
//     meta horizon never reset by a hook fire
//   - the built-ins gate: the ONE place all three typed-channel writers agree
//     about Claude Code's own slash commands — dropped by default, counted
//     apart from `skipped`, flipped by a DURABLE preference, and scoped to
//     (channel "typed", provider "claude") and nothing else
//   - owner-only store permissions (0700 dir / 0600 files) + retrofit chmod
//   - provenance write-once per id
//   - meta trackedSince stability across opens, incl. corrupt-meta recovery
// Fixture stores are COPIED into mkdtemp dirs before opening (open writes
// meta.json) and every ledger gets an injected base — the real $HOME is
// never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "ledger");
const { openLedger, LEDGER_SCHEMA_VERSION, isLedgerEvent, NAME_RE, AGENT_NAME_RE } = await import(
  pathToFileURL(join(root, "dist", "ledger.js")).href
);
// The gate reads the SHARED set — one list, not one per writer.
const { BUILTIN_COMMANDS } = await import(pathToFileURL(join(root, "dist", "types.js")).href);

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
const freshBase = () => {
  const d = mkdtempSync(join(tmpdir(), "context-audit-ledger-"));
  tmps.push(d);
  return d;
};
const fixtureBase = (name) => {
  const d = freshBase();
  cpSync(join(fixtures, name), d, { recursive: true });
  return d;
};

// 2025 timestamps keep the routing assertions clear of the wall-clock month.
const ev = (id, ts, extra = {}) => ({
  v: 1,
  id,
  ts,
  provider: "claude",
  kind: "skill",
  name: "impeccable",
  channel: "auto",
  sessionId: "s1",
  project: "/tmp/proj",
  ...extra,
});

// --- append + dedupe idempotency ------------------------------------------
console.log("APPEND + DEDUPE:");
{
  const base = freshBase();
  const led = openLedger(base);
  const batch = [
    ev("e1", "2025-03-05T10:00:00.000Z"),
    ev("e2", "2025-03-20T11:00:00.000Z", { channel: "typed", outcome: "ok" }),
    ev("e3", "2025-04-02T12:00:00.000Z", { kind: "agent", name: "code-reviewer" }),
  ];
  const r1 = led.appendEvents(batch);
  check("first append lands all", r1.appended === 3 && r1.skipped === 0, JSON.stringify(r1));
  const r2 = led.appendEvents(batch);
  check("second append of same ids is a no-op", r2.appended === 0 && r2.skipped === 3 && r2.enriched === 0, JSON.stringify(r2));
  check("store holds each event once", led.readEvents().length === 3);

  const reopened = openLedger(base);
  const r3 = reopened.appendEvents([batch[0]]);
  check("dedupe index survives reopen", r3.appended === 0 && r3.skipped === 1, JSON.stringify(r3));
  check("reopen reads the same 3 events", reopened.readEvents().length === 3);

  // --- monthly routing ----------------------------------------------------
  console.log("MONTHLY ROUTING:");
  const usage = join(base, "usage");
  const mar = join(usage, "events-2025-03.jsonl");
  const apr = join(usage, "events-2025-04.jsonl");
  check("2025-03 events routed to events-2025-03.jsonl", existsSync(mar) && readFileSync(mar, "utf8").trim().split("\n").length === 2);
  check("2025-04 event routed to events-2025-04.jsonl", existsSync(apr) && readFileSync(apr, "utf8").trim().split("\n").length === 1);
  const wallClockFile = join(usage, `events-${new Date().toISOString().slice(0, 7)}.jsonl`);
  check("no file for the wall-clock month", !existsSync(wallClockFile));

  // --- filters + deterministic order --------------------------------------
  console.log("READ FILTERS + ORDER:");
  const skills = led.readEvents({ provider: "claude", kind: "skill", name: "impeccable" });
  check("(provider, kind, name) filter isolates the skill", skills.length === 2);
  const all = led.readEvents();
  check(
    "events come back ts-sorted regardless of append order",
    all.every((e, i) => i === 0 || all[i - 1].ts <= e.ts)
  );
  check("since/until bounds are inclusive", led.readEvents({ since: "2025-03-20T11:00:00.000Z", until: "2025-04-02T12:00:00.000Z" }).length === 2);

  // --- meta stability ------------------------------------------------------
  console.log("META:");
  const m1 = led.meta();
  const m2 = openLedger(base).meta();
  check("schemaVersion recorded", m1.schemaVersion === LEDGER_SCHEMA_VERSION);
  check("trackedSince stable across opens", m1.trackedSince === m2.trackedSince, `${m1.trackedSince} vs ${m2.trackedSince}`);
  check("meta.json exists on disk", existsSync(join(usage, "meta.json")));

  // --- snapshots ------------------------------------------------------------
  console.log("SNAPSHOTS:");
  led.appendSnapshot({ ts: "2025-04-01T00:00:00.000Z", items: 10, enabled: 8, injectedChars: 1200, byProvider: { claude: 9, codex: 1 } });
  led.appendSnapshot({ ts: "2025-04-02T00:00:00.000Z", items: 11, enabled: 9, injectedChars: 1300, byProvider: { claude: 10, codex: 1 } });
  check("snapshots read back in-process", led.readSnapshots().length === 2);
  const snaps = openLedger(base).readSnapshots();
  check("snapshots persist across reopen", snaps.length === 2 && snaps[1].items === 11);
}

// --- duplicate-id enrichment ------------------------------------------------
// A hook banks a poor real-time record (no outcome, no src); the scan later
// re-derives the SAME id from the transcript, enriched. The duplicate must
// fill the survivor's gaps — durably — while counts stay exactly deduped.
console.log("DEDUPE ENRICHMENT:");
{
  const base = freshBase();
  const led = openLedger(base);
  const poor = ev("sess:toolu_1", "2025-06-10T10:00:00.000Z");
  check("poor record lands first", led.appendEvents([poor]).appended === 1);
  const rich = ev("sess:toolu_1", "2025-06-10T10:00:00.123Z", {
    outcome: "error",
    interrupted: true,
    src: { file: "/tmp/transcript.jsonl", line: 7 },
    model: "claude-fable-5",
    entrypoint: "cli",
    caller: "user",
    agent: { id: "a1", type: "code-reviewer" },
  });
  const r = led.appendEvents([rich]);
  check("duplicate id is skipped but flagged enriched", r.appended === 0 && r.skipped === 1 && r.enriched === 1, JSON.stringify(r));
  const got = led.readEvents();
  check("store still holds the event once", got.length === 1);
  check(
    "missing optional fields folded onto the survivor",
    got[0].outcome === "error" &&
      got[0].interrupted === true &&
      got[0].src?.line === 7 &&
      got[0].model === "claude-fable-5" &&
      got[0].entrypoint === "cli" &&
      got[0].caller === "user" &&
      got[0].agent?.type === "code-reviewer",
    JSON.stringify(got[0])
  );
  check("survivor keeps its own core fields (first-sighting ts)", got[0].ts === "2025-06-10T10:00:00.000Z");

  const conflicting = ev("sess:toolu_1", "2025-06-10T10:00:00.500Z", { outcome: "ok" });
  const r2 = led.appendEvents([conflicting]);
  check("already-set fields are never overwritten", r2.enriched === 0 && led.readEvents()[0].outcome === "error", JSON.stringify(r2));

  // Durability: the merged record was appended, and the load-time merge folds
  // the poor line + merged line back into one enriched event after reopen.
  const after = openLedger(base).readEvents();
  check(
    "enrichment survives reopen via the load-time merge",
    after.length === 1 && after[0].outcome === "error" && after[0].src?.line === 7 && after[0].interrupted === true,
    JSON.stringify(after)
  );
}

// --- malformed-line tolerance ---------------------------------------------
console.log("MALFORMED STORE (fixture):");
{
  const led = openLedger(fixtureBase("malformed-store"));
  const events = led.readEvents();
  check("valid lines survive", events.length === 2 && events[0].id === "fx-good-1");
  const d = led.diagnostics();
  check("malformed lines counted, not fatal", d.malformedLines === 5, JSON.stringify(d));
  check("counts attributed to the file", d.byFile["events-2026-06.jsonl"] === 5, JSON.stringify(d.byFile));
  check("gate-passing-prefix invalid ts (2026-99) is skipped, not stored", events.every((e) => e.id !== "fx-bad-ts"));
  check("args-shaped name is skipped, not stored", events.every((e) => e.id !== "fx-bad-name"));
  const r = led.appendEvents([ev("fx-good-1", "2026-06-05T10:00:00.000Z"), ev("fx-new", "2026-06-20T10:00:00.000Z")]);
  check("append still works and dedupes against surviving lines", r.appended === 1 && r.skipped === 1, JSON.stringify(r));
}

// --- append mode ------------------------------------------------------------
// The per-hook-fire path: no historical parse at open, id dedupe against the
// target month only, and the meta horizon is never reset by a hook fire.
console.log("APPEND MODE:");
{
  const base = freshBase();
  openLedger(base).appendEvents([ev("a1", "2025-03-05T10:00:00.000Z"), ev("a2", "2025-04-02T12:00:00.000Z")]);
  const led = openLedger(base, { mode: "append" });
  const r1 = led.appendEvents([ev("a1", "2025-03-05T10:00:00.000Z")]);
  check("same-month duplicate is still skipped", r1.appended === 0 && r1.skipped === 1, JSON.stringify(r1));
  const r2 = led.appendEvents([ev("a3", "2025-03-09T10:00:00.000Z")]);
  check("new event appends", r2.appended === 1 && r2.skipped === 0, JSON.stringify(r2));
  check("full reopen holds each event exactly once", openLedger(base).readEvents().length === 3);

  // The point of the mode: nothing historical is parsed at open.
  const lazy = openLedger(fixtureBase("malformed-store"), { mode: "append" });
  check("append mode parses nothing at open", lazy.diagnostics().malformedLines === 0, JSON.stringify(lazy.diagnostics()));
  const r3 = lazy.appendEvents([ev("fx-good-1", "2026-06-05T10:00:00.000Z")]);
  check("target-month id check still dedupes", r3.appended === 0 && r3.skipped === 1, JSON.stringify(r3));

  const fresh = freshBase();
  const am = openLedger(fresh, { mode: "append" });
  am.appendEvents([ev("m1", "2025-02-01T08:00:00.000Z")]);
  check("append mode writes no meta.json", !existsSync(join(fresh, "usage", "meta.json")));
  check(
    "full open then establishes trackedSince from the oldest stored event",
    openLedger(fresh).meta().trackedSince === "2025-02-01T08:00:00.000Z",
    openLedger(fresh).meta().trackedSince
  );
}

// --- built-ins gate ---------------------------------------------------------
// Scan ingestion, hooks and backfill each used to decide for themselves whether
// a typed `/usage` was a fire, so the SAME dispatch was banked or dropped
// depending on which channel happened to see it. The gate now lives here, at
// the one place all three writers pass through, and the opt-in is durable
// because a CLI flag can never reach a hook firing inside someone else's
// session. Every scoping rule below is a rule about not silently dropping
// something real.
console.log("BUILT-INS GATE:");
const typed = (id, name, extra = {}) =>
  ev(id, "2025-05-01T09:00:00.000Z", { kind: "command", name, channel: "typed", ...extra });
{
  const base = freshBase();
  const led = openLedger(base);

  const r1 = led.appendEvents([typed("b1", "compact")]);
  check("a typed claude built-in is dropped", r1.appended === 0 && r1.droppedBuiltins === 1, JSON.stringify(r1));
  // `skipped` means "already banked, or malformed". Folding drops into it would
  // report a refused fire back to the user as one already recorded.
  check("...and counted apart from skipped/enriched", r1.skipped === 0 && r1.enriched === 0, JSON.stringify(r1));
  check("the dropped built-in is not stored", led.readEvents().length === 0);
  check("a batch of only built-ins writes no file at all", !existsSync(join(base, "usage", "events-2025-05.jsonl")));
  // Absent is not false: nobody has answered the question yet, and the meta
  // says so rather than claiming the user opted out.
  check("the preference is absent by default", led.meta().includeBuiltins === undefined, JSON.stringify(led.meta()));

  const every = [...BUILTIN_COMMANDS].map((n, i) => typed(`bset-${i}`, n));
  const rAll = led.appendEvents(every);
  check(
    "every member of the shared BUILTIN_COMMANDS set is refused",
    rAll.droppedBuiltins === BUILTIN_COMMANDS.size && rAll.appended === 0,
    JSON.stringify(rAll)
  );
  check("a typed name that is not a built-in still lands", led.appendEvents([typed("b2", "impeccable")]).appended === 1);
  // The kind hint is never trusted anywhere in this system (invariant 3): the
  // gate keys on the name and the channel, so a writer's guess cannot buy a
  // built-in its way in.
  check(
    "the kind hint does not exempt a typed built-in",
    led.appendEvents([typed("b3", "config", { kind: "skill" })]).droppedBuiltins === 1
  );

  // --- scoping: channel -----------------------------------------------------
  const rAuto = led.appendEvents([ev("b4", "2025-05-02T09:00:00.000Z", { name: "compact" })]);
  check("an auto-channel event named compact is a skill fire, not a slash command — it lands", rAuto.appended === 1 && rAuto.droppedBuiltins === 0);
  const rLoad = led.appendEvents([
    ev("b5", "2025-05-02T10:00:00.000Z", { provider: "codex", kind: "instructions", name: "/Users/fx/context", channel: "load" }),
  ]);
  check("a load-channel event is never gated", rLoad.appended === 1 && rLoad.droppedBuiltins === 0);

  // --- scoping: provider ----------------------------------------------------
  // The list is Claude Code's. A Codex prompt named `status` is a real asset in
  // the user's inventory that joins to a real row, and dropping it would be a
  // silent undercount of something that exists.
  const rCodex = led.appendEvents([
    ev("b6", "2025-05-03T09:00:00.000Z", { provider: "codex", kind: "prompt", name: "status", channel: "typed" }),
  ]);
  check("a codex typed prompt named status is never dropped", rCodex.appended === 1 && rCodex.droppedBuiltins === 0, JSON.stringify(rCodex));

  // --- four independent counters -------------------------------------------
  const rMix = led.appendEvents([
    typed("b7", "plan-review"),
    typed("b2", "impeccable"),
    { not: "an event" },
    typed("b8", "usage"),
  ]);
  check(
    "appended / skipped / droppedBuiltins / enriched never borrow from each other",
    rMix.appended === 1 && rMix.skipped === 2 && rMix.droppedBuiltins === 1 && rMix.enriched === 0,
    JSON.stringify(rMix)
  );

  // --- the durable opt-in ---------------------------------------------------
  console.log("BUILT-INS PREFERENCE (durable):");
  led.setIncludeBuiltins(true);
  check("meta records the preference", led.meta().includeBuiltins === true);
  const rOn = led.appendEvents([typed("b9", "usage")]);
  check("with the preference on, a built-in lands", rOn.appended === 1 && rOn.droppedBuiltins === 0, JSON.stringify(rOn));
  const stored = JSON.parse(readFileSync(join(base, "usage", "meta.json"), "utf8"));
  check("it is persisted to meta.json", stored.includeBuiltins === true, JSON.stringify(stored));
  check("persisting it never moves the tracked-since horizon", stored.trackedSince === led.meta().trackedSince);

  const reopened = openLedger(base);
  check("the preference survives a reopen", reopened.meta().includeBuiltins === true);
  // This is what makes the rule symmetric: a ledger opened by a hook inside
  // someone else's session reads the same answer off disk.
  check("a ledger that never saw the flag honours it", reopened.appendEvents([typed("b10", "status")]).appended === 1);

  const off = openLedger(base);
  off.setIncludeBuiltins(false);
  check("turning it back off is durable too", openLedger(base).meta().includeBuiltins === false);
  check("new built-ins are refused again", off.appendEvents([typed("b11", "model")]).droppedBuiltins === 1);
  // The store is append-only and never rewritten: flipping the preference off
  // does not retract fires banked while it was on, which would silently change
  // a lifetime count the user was already shown.
  check(
    "built-ins banked while it was on are never retracted",
    openLedger(base).readEvents().filter((e) => e.name === "usage" && e.channel === "typed").length === 1
  );

  // --- the gate never breaks enrichment (invariant 1) -----------------------
  // `b9` was banked while the preference was on; the preference is off now. A
  // later same-id sighting must still fill the survivor's gaps — otherwise
  // turning built-ins off would silently strip fields off events already stored.
  const rEnrich = off.appendEvents([typed("b9", "usage", { outcome: "ok", src: { file: "/tmp/history.jsonl", line: 3 } })]);
  check(
    "a duplicate id enriches even when its name is a refused built-in",
    rEnrich.skipped === 1 && rEnrich.enriched === 1 && rEnrich.droppedBuiltins === 0,
    JSON.stringify(rEnrich)
  );
  const survivor = openLedger(base).readEvents().find((e) => e.id === "b9");
  check(
    "and the enrichment is durable",
    survivor?.outcome === "ok" && survivor?.src?.line === 3,
    JSON.stringify(survivor)
  );
}

// A hand-edited meta must not be able to turn built-in capture on for every
// writer on the machine by accident.
console.log("BUILT-INS PREFERENCE (hand-edited meta):");
{
  const base = freshBase();
  openLedger(base);
  writeFileSync(
    join(base, "usage", "meta.json"),
    JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, trackedSince: "2025-01-01T00:00:00.000Z", includeBuiltins: "yes" }) + "\n"
  );
  const led = openLedger(base);
  check("a non-boolean preference is dropped, not coerced", led.meta().includeBuiltins === undefined, JSON.stringify(led.meta()));
  check("so a truthy string cannot turn capture on", led.appendEvents([typed("h1", "usage")]).droppedBuiltins === 1);
  check("the rest of the meta still loads", led.meta().trackedSince === "2025-01-01T00:00:00.000Z");
}

// The hook path opens in append mode, where meta.json may not exist yet.
console.log("BUILT-INS PREFERENCE (append mode):");
{
  const base = freshBase();
  const am = openLedger(base, { mode: "append" });
  am.setIncludeBuiltins(true);
  // Persisting here would write out this ledger's FABRICATED trackedSince (its
  // own wall clock) and reset every lifetime figure to the moment a hook fired.
  check("no meta.json means the preference stays in this process", !existsSync(join(base, "usage", "meta.json")));
  check("...and still governs this process's appends", am.appendEvents([typed("k1", "usage")]).appended === 1);
  check("a later full open does not inherit it", openLedger(base).meta().includeBuiltins === undefined);

  const trackedSince = openLedger(base).meta().trackedSince;
  const am2 = openLedger(base, { mode: "append" });
  am2.setIncludeBuiltins(true);
  const meta = JSON.parse(readFileSync(join(base, "usage", "meta.json"), "utf8"));
  check("once a horizon exists, an append-mode writer persists the preference", meta.includeBuiltins === true, JSON.stringify(meta));
  check("...without moving trackedSince", meta.trackedSince === trackedSince, `${meta.trackedSince} vs ${trackedSince}`);
}

// --- store permissions ------------------------------------------------------
// Events are a behavioral profile that outlives the transcript purge: the
// store is owner-only, and pre-existing stores are retrofitted at open.
console.log("PERMISSIONS:");
if (process.platform !== "win32") {
  const base = freshBase();
  const led = openLedger(base);
  led.appendEvents([ev("p1", "2025-03-05T10:00:00.000Z")]);
  led.appendSnapshot({ ts: "2025-03-06T00:00:00.000Z", items: 1, enabled: 1, injectedChars: 10, byProvider: { claude: 1 } });
  const usage = join(base, "usage");
  const mode = (p) => statSync(p).mode & 0o777;
  check("usage dir is 0700", mode(usage) === 0o700, mode(usage).toString(8));
  check("event files are 0600", mode(join(usage, "events-2025-03.jsonl")) === 0o600, mode(join(usage, "events-2025-03.jsonl")).toString(8));
  check("meta.json is 0600", mode(join(usage, "meta.json")) === 0o600);
  check("snapshots.jsonl is 0600", mode(join(usage, "snapshots.jsonl")) === 0o600);

  const fb = fixtureBase("malformed-store");
  chmodSync(join(fb, "usage"), 0o755);
  chmodSync(join(fb, "usage", "events-2026-06.jsonl"), 0o644);
  openLedger(fb);
  check("retrofit chmod on open: dir tightened to 0700", mode(join(fb, "usage")) === 0o700);
  check("retrofit chmod on open: events file tightened to 0600", mode(join(fb, "usage", "events-2026-06.jsonl")) === 0o600);
} else {
  ok("permissions checks skipped on win32");
}

// --- corrupt meta recovery -------------------------------------------------
console.log("CORRUPT META (fixture):");
{
  const base = fixtureBase("corrupt-meta");
  const led = openLedger(base);
  check(
    "trackedSince recovers to oldest stored event, not now",
    led.meta().trackedSince === "2026-05-30T08:00:00.000Z",
    led.meta().trackedSince
  );
  check("corrupt meta counted in diagnostics", led.diagnostics().byFile["meta.json"] === 1);
  check("recovered trackedSince stable on reopen", openLedger(base).meta().trackedSince === "2026-05-30T08:00:00.000Z");
}

// --- provenance write-once -------------------------------------------------
console.log("PROVENANCE:");
{
  const base = freshBase();
  const led = openLedger(base);
  led.writeProvenance({ a: { installedAt: "2026-01-01T00:00:00.000Z", source: "birthtime" } });
  led.writeProvenance({
    a: { installedAt: "2027-12-31T00:00:00.000Z", source: "mtime" },
    b: { installedAt: "2026-02-02T00:00:00.000Z", source: "git", origin: "claude-plugins-official" },
  });
  const p = led.readProvenance();
  check("first sighting wins", p.a.installedAt === "2026-01-01T00:00:00.000Z" && p.a.source === "birthtime");
  check("new ids still land", p.b?.origin === "claude-plugins-official");
  p.c = { installedAt: "2026-03-03T00:00:00.000Z", source: "first-seen" };
  check("mutating the returned map does not write through", !("c" in led.readProvenance()));
  const p2 = openLedger(base).readProvenance();
  check("write-once persists across reopen", p2.a.installedAt === "2026-01-01T00:00:00.000Z" && "b" in p2);
}

// --- event shape gate + env override ---------------------------------------
console.log("SHAPE GATE + BASE RESOLUTION:");
{
  check("valid event passes the gate", isLedgerEvent(ev("g1", "2025-01-01T00:00:00.000Z")));
  check("missing sessionId fails the gate", !isLedgerEvent({ ...ev("g2", "2025-01-01T00:00:00.000Z"), sessionId: undefined }));
  check("junk ts fails the gate", !isLedgerEvent(ev("g3", "not-a-date")));
  check("junk channel fails the gate", !isLedgerEvent(ev("g4", "2025-01-01T00:00:00.000Z", { channel: "psychic" })));
  // ts must actually parse: a month-prefixed junk string would pick a junk
  // monthly file on append and crash date math downstream.
  check("month-prefixed junk ts fails the gate", !isLedgerEvent(ev("g5", "2026-99")));
  check("calendar-invalid ts fails the gate", !isLedgerEvent(ev("g6", "2026-13-01T00:00:00.000Z")));
  // The dispatch-token gate is exported for every writer to share, and the
  // durable boundary enforces token-shaped names on dispatch channels itself.
  check("NAME_RE accepts dispatch tokens incl. plugin namespaces", NAME_RE.test("impeccable") && NAME_RE.test("superpowers:brainstorming"));
  check("NAME_RE refuses args-shaped strings", !NAME_RE.test("impeccable teach --project ~/clients/acme"));
  check("args-shaped name fails the gate on dispatch channels", !isLedgerEvent(ev("g7", "2025-01-01T00:00:00.000Z", { name: "impeccable SECRET-ARG never store me" })));

  // --- the agent channel's own rule, and the boundary it must not move ------
  // AGENT_NAME_RE exists because `subagent_type` is a structured tool parameter
  // carrying a registered frontmatter name, with no user-typed line behind it
  // and no argument tail to strip. It is a SECOND rule beside NAME_RE, never a
  // widening of it: the six assertions above must keep holding afterwards,
  // which is what the two re-pins below check on the durable boundary.
  check(
    "AGENT_NAME_RE accepts a registered agent's prose name",
    AGENT_NAME_RE.test("LinkedIn Content Creator") && AGENT_NAME_RE.test("Backend Architect")
  );
  check(
    "AGENT_NAME_RE accepts 60 chars with the characters real agent names use",
    AGENT_NAME_RE.test("Research & Analysis, Ops/Infra, Delivery Coordination Agents")
  );
  check("AGENT_NAME_RE refuses a control character", !AGENT_NAME_RE.test("general\u0000purpose"));
  check("AGENT_NAME_RE refuses a name past 80 characters", !AGENT_NAME_RE.test("x".repeat(81)) && AGENT_NAME_RE.test("x".repeat(80)));
  check("AGENT_NAME_RE refuses the empty string", !AGENT_NAME_RE.test(""));
  check(
    "the durable boundary admits a spaced name on an agent event",
    isLedgerEvent(ev("g10", "2025-01-01T00:00:00.000Z", { kind: "agent", name: "LinkedIn Content Creator" }))
  );
  check(
    "the durable boundary refuses a control character on an agent event",
    !isLedgerEvent(ev("g11", "2025-01-01T00:00:00.000Z", { kind: "agent", name: "general\u0000purpose" }))
  );
  // The regression this change came closest to causing: the SAME string, now
  // that a laxer rule exists, is still refused on the channels it can reach
  // from a typed line.
  check(
    "args-shaped name is STILL refused on a skill event after AGENT_NAME_RE exists",
    !isLedgerEvent(ev("g12", "2025-01-01T00:00:00.000Z", { kind: "skill", name: "impeccable teach --project ~/clients/acme" }))
  );
  check(
    "args-shaped name is STILL refused on a command event after AGENT_NAME_RE exists",
    !isLedgerEvent(ev("g13", "2025-01-01T00:00:00.000Z", { kind: "command", channel: "typed", name: "impeccable teach --project ~/clients/acme" }))
  );
  check(
    "dotted codex names pass the durable gate",
    isLedgerEvent(ev("g8", "2025-01-01T00:00:00.000Z", { provider: "codex", kind: "prompt", name: "release.notes", channel: "typed" }))
  );
  check(
    "load-channel path names are exempt from the token gate",
    isLedgerEvent(ev("g9", "2025-01-01T00:00:00.000Z", { provider: "codex", kind: "instructions", name: "/Users/fx/my proj", channel: "load" }))
  );

  // --- compatibility: a store written under the old narrow rule -------------
  // Widening what is ACCEPTED is backward-compatible by construction: every
  // event already banked still validates, and nothing rewrites the store.
  {
    const old = freshBase();
    const usage = join(old, "usage");
    mkdirSync(usage, { recursive: true });
    const file = join(usage, "events-2025-02.jsonl");
    const lines =
      [
        ev("old1", "2025-02-01T10:00:00.000Z"),
        ev("old2", "2025-02-02T10:00:00.000Z", { kind: "command", channel: "typed", name: "deploy-check" }),
        // An agent fire banked under the old rule: the only agent names that
        // could pass it were token-shaped, and they must still load.
        ev("old3", "2025-02-03T10:00:00.000Z", { kind: "agent", name: "code-reviewer" }),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n";
    writeFileSync(file, lines);
    const reopened = openLedger(old);
    check("a pre-existing narrow-rule ledger still loads whole", reopened.readEvents().length === 3, JSON.stringify(reopened.readEvents().length));
    check("its lines are unchanged on disk — no migration runs", readFileSync(file, "utf8") === lines);
    check("and it reports no malformed lines", reopened.diagnostics().malformedLines === 0, JSON.stringify(reopened.diagnostics()));
  }

  const base = freshBase();
  process.env.CONTEXT_AUDIT_HOME = base;
  try {
    const led = openLedger();
    check("CONTEXT_AUDIT_HOME overrides the default base", led.dir === join(base, "usage"), led.dir);
  } finally {
    delete process.env.CONTEXT_AUDIT_HOME;
  }
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall ledger checks passed");
process.exit(failures ? 1 : 0);
