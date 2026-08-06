#!/usr/bin/env node
// Unit corpus for the durable usage ledger (src/ledger.ts):
//   - append+dedupe idempotency, in-process and across reopens
//   - duplicate-id ENRICHMENT: later sightings fill missing optional fields,
//     durably, without ever double-counting or overwriting set fields
//   - monthly file routing by event ts, never wall clock
//   - malformed-line tolerance (skipped, counted, never a crash), incl.
//     month-prefixed junk timestamps and args-shaped names
//   - append mode: no historical parse at open, per-month id dedupe,
//     meta horizon never reset by a hook fire
//   - owner-only store permissions (0700 dir / 0600 files) + retrofit chmod
//   - provenance write-once per id
//   - meta trackedSince stability across opens, incl. corrupt-meta recovery
// Fixture stores are COPIED into mkdtemp dirs before opening (open writes
// meta.json) and every ledger gets an injected base — the real $HOME is
// never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "ledger");
const { openLedger, LEDGER_SCHEMA_VERSION, isLedgerEvent, NAME_RE } = await import(
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
  check(
    "dotted codex names pass the durable gate",
    isLedgerEvent(ev("g8", "2025-01-01T00:00:00.000Z", { provider: "codex", kind: "prompt", name: "release.notes", channel: "typed" }))
  );
  check(
    "load-channel path names are exempt from the token gate",
    isLedgerEvent(ev("g9", "2025-01-01T00:00:00.000Z", { provider: "codex", kind: "instructions", name: "/Users/fx/my proj", channel: "load" }))
  );

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
