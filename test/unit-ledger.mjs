#!/usr/bin/env node
// Unit corpus for the durable usage ledger (src/ledger.ts):
//   - append+dedupe idempotency, in-process and across reopens
//   - monthly file routing by event ts, never wall clock
//   - malformed-line tolerance (skipped, counted, never a crash)
//   - provenance write-once per id
//   - meta trackedSince stability across opens, incl. corrupt-meta recovery
// Fixture stores are COPIED into mkdtemp dirs before opening (open writes
// meta.json) and every ledger gets an injected base — the real $HOME is
// never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "ledger");
const { openLedger, LEDGER_SCHEMA_VERSION, isLedgerEvent } = await import(
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
  check("second append of same ids is a no-op", r2.appended === 0 && r2.skipped === 3, JSON.stringify(r2));
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

// --- malformed-line tolerance ---------------------------------------------
console.log("MALFORMED STORE (fixture):");
{
  const led = openLedger(fixtureBase("malformed-store"));
  const events = led.readEvents();
  check("valid lines survive", events.length === 2 && events[0].id === "fx-good-1");
  const d = led.diagnostics();
  check("malformed lines counted, not fatal", d.malformedLines === 3, JSON.stringify(d));
  check("counts attributed to the file", d.byFile["events-2026-06.jsonl"] === 3, JSON.stringify(d.byFile));
  const r = led.appendEvents([ev("fx-good-1", "2026-06-05T10:00:00.000Z"), ev("fx-new", "2026-06-20T10:00:00.000Z")]);
  check("append still works and dedupes against surviving lines", r.appended === 1 && r.skipped === 1, JSON.stringify(r));
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
