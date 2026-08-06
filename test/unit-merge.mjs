#!/usr/bin/env node
// Unit corpus for scan wiring + ledger merge + open-event (src/sources/index.ts,
// src/ui/inventory.ts, src/ui/server.ts):
//   - buildUiPayload banks adapter events into the injected ledger home and is
//     idempotent across reruns (byte-identical monthly files, stable payload)
//   - the (provider, kind, name) join: window figures beside lifetime figures,
//     trackedSince, byChannel, byProvider, outcomes, ISO-week bins, and a
//     reverse-chron events page that carries ids only — never paths
//   - the shadowed-twin no-double-count rule survives the ledger join
//   - exact-name collisions within one provider+kind are flagged on all copies
//   - dead weight gates on provenance (installed before the window start)
//   - AGENTS.md items gain readBy + load fires from codex load events
//   - a broken ledger degrades to window-only figures (payload) / a caveat
//     (auditSource), never a crash
//   - POST /api/open-event resolves src from the server's ledger and refuses
//     purged transcripts with "transcript deleted (event retained)"
// The fixture home is COPIED to a mkdtemp dir; the real $HOME is never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildUiPayload, itemId } = await import(pathToFileURL(join(root, "dist", "ui", "inventory.js")).href);
const { auditSource } = await import(pathToFileURL(join(root, "dist", "sources", "index.js")).href);
const { claudeAdapter } = await import(pathToFileURL(join(root, "dist", "sources", "claude.js")).href);
const { startUiServer } = await import(pathToFileURL(join(root, "dist", "ui", "server.js")).href);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

const tmp = mkdtempSync(join(tmpdir(), "context-audit-merge-"));
const home = join(tmp, "home");
cpSync(join(root, "test", "fixtures", "merge", "home"), home, { recursive: true });
const cwd = join(home, "proj");
// The rollout announces its AGENTS.md load with an absolute directory, which
// only exists at runtime — template it in.
const rollout = join(home, ".codex", "sessions", "2026", "07", "06", "rollout-2026-07-06T08-00-00-sess-x1.jsonl");
writeFileSync(rollout, readFileSync(rollout, "utf8").replaceAll("__CWD__", cwd));

const ledgerHome = join(tmp, "ledger");
cpSync(join(root, "test", "fixtures", "merge", "ledger-seed"), ledgerHome, { recursive: true });
// A pre-existing provenance record is write-once: it must survive the scan's
// own (fresh-birthtime) resolution, which is also what lets this test pin the
// dead-weight age gate deterministically on any filesystem.
const dwId = itemId("claude", "skill", join(home, ".claude", "skills", "dead-weight"));
writeFileSync(
  join(ledgerHome, "usage", "provenance.json"),
  JSON.stringify({ [dwId]: { installedAt: "2026-01-01T00:00:00.000Z", source: "birthtime" } }) + "\n"
);

const ctx = { home, cwd, ledgerHome };
const p1 = await buildUiPayload(ctx, { history: true });

console.log("WINDOW + LIFETIME (never conflated):");
const imp = p1.items.find((i) => i.name === "impeccable" && i.enabled);
check("window figures unchanged by the ledger join", imp?.fires?.invocations === 3 && imp?.fires?.sessions === 1, JSON.stringify(imp?.fires));
check("lifetime counts include the pre-purge seeded event", imp?.fires?.lifetime?.invocations === 4 && imp?.fires?.lifetime?.sessions === 2, JSON.stringify(imp?.fires?.lifetime));
check("lifetime first/last span seed to window", imp?.fires?.lifetime?.firstFired === "2026-03-01T12:00:00.000Z" && imp?.fires?.lifetime?.lastFired === "2026-07-09T09:05:00.000Z");
check("trackedSince comes from ledger meta", imp?.fires?.trackedSince === "2026-03-01T00:00:00.000Z", imp?.fires?.trackedSince);
check("byChannel splits auto vs typed", imp?.fires?.byChannel?.auto === 3 && imp?.fires?.byChannel?.typed === 1, JSON.stringify(imp?.fires?.byChannel));
check("byProvider counts lifetime fires per provider", imp?.fires?.byProvider?.claude === 4, JSON.stringify(imp?.fires?.byProvider));
check("outcomes split ok/error/rejected", imp?.fires?.outcomes?.ok === 2 && imp?.fires?.outcomes?.error === 1 && imp?.fires?.outcomes?.rejected === 0, JSON.stringify(imp?.fires?.outcomes));
check(
  "weeklyBins bucket by ISO week (Monday, UTC)",
  JSON.stringify(imp?.fires?.weeklyBins) ===
    '[{"weekStart":"2026-02-23","count":1},{"weekStart":"2026-06-29","count":1},{"weekStart":"2026-07-06","count":2}]',
  JSON.stringify(imp?.fires?.weeklyBins)
);
const evPage = imp?.fires?.events ?? [];
check("events page is reverse-chron", evPage.length === 4 && evPage[0].id === "s1:2026-07-09T09:05:00.000Z:impeccable" && evPage[3].id === "old1", JSON.stringify(evPage.map((e) => e.id)));
check("event rows carry the project display name, not the path", evPage[0]?.project === "proj" && evPage[3]?.project === "proj");
const evJson = JSON.stringify(evPage);
check("event rows carry no paths and no src pointers", !evJson.includes("src") && !evJson.includes("/purged") && !evJson.includes(".jsonl") && !evJson.includes("/work/"), evJson);

console.log("TWINS + COLLISIONS:");
const impOff = p1.items.find((i) => i.name === "impeccable" && !i.enabled);
check("shadowed twin still gets no fires field", impOff !== undefined && !("fires" in impOff));
check("the twin pair is not a collision", imp?.collision === undefined && impOff?.collision === undefined);
const shipUser = p1.items.find((i) => i.name === "ship-it" && i.scope === "user");
const shipProj = p1.items.find((i) => i.name === "ship-it" && i.scope === "project");
check(
  "same name at two scopes flags collision on both copies",
  JSON.stringify(shipUser?.collision?.paths) === JSON.stringify([shipProj?.path]) &&
    JSON.stringify(shipProj?.collision?.paths) === JSON.stringify([shipUser?.path]),
  JSON.stringify([shipUser?.collision, shipProj?.collision])
);
check(
  "colliding copies share the name's (unsplittable) fires",
  shipUser?.fires?.lifetime?.invocations === 1 && shipProj?.fires?.lifetime?.invocations === 1 &&
    shipUser?.fires?.byChannel?.typed === 1 && shipUser?.fires?.byChannel?.auto === 0,
  JSON.stringify(shipUser?.fires)
);

console.log("DEAD WEIGHT (provenance age gate):");
const dw = p1.items.find((i) => i.name === "dead-weight");
const fresh = p1.items.find((i) => i.name === "fresh-never");
check("never-fired items stay null under the ledger join", dw?.fires === null && fresh?.fires === null);
check("write-once provenance survives the rescan resolution", dw?.provenance?.installedAt === "2026-01-01T00:00:00.000Z" && dw?.provenance?.source === "birthtime", JSON.stringify(dw?.provenance));
check("freshly created item has provenance dated inside/after the window", fresh?.provenance !== undefined && fresh.provenance.installedAt > "2026-07-01T10:00:00.000Z", JSON.stringify(fresh?.provenance));
check(
  "deadWeightChars counts only zero-fire items installed before the window",
  p1.header.deadWeightChars === dw?.injectedChars && (dw?.injectedChars ?? 0) > 0,
  `deadWeightChars ${p1.header.deadWeightChars} vs dead-weight ${dw?.injectedChars} (+fresh ${fresh?.injectedChars})`
);

console.log("CODEX + AGENTS.MD (readBy and per-provider fires):");
const ship = p1.items.find((i) => i.name === "ship" && i.source === "codex");
check("codex window keeps its line-based count beside the event-based lifetime", ship?.fires?.invocations === 2 && ship?.fires?.lifetime?.invocations === 1, JSON.stringify(ship?.fires));
const agents = p1.items.find((i) => i.source === "agents-md" && i.name === "AGENTS.md");
check("AGENTS.md gains readBy from the codex load event", JSON.stringify(agents?.readBy) === '["codex"]', JSON.stringify(agents?.readBy));
check(
  "AGENTS.md load fires attach with provider attribution and load channel",
  agents?.fires?.invocations === 1 && agents?.fires?.lifetime?.invocations === 1 &&
    agents?.fires?.byProvider?.codex === 1 && agents?.fires?.events?.[0]?.channel === "load" &&
    agents?.fires?.byChannel === undefined,
  JSON.stringify(agents?.fires)
);
const codexAgents = p1.items.find((i) => i.name === "~/.codex/AGENTS.md");
check("~/.codex/AGENTS.md is readBy codex by construction", JSON.stringify(codexAgents?.readBy) === '["codex"]' && !("fires" in (codexAgents ?? {})));
check(
  "merged history spans both providers' windows",
  p1.history?.transcriptFiles === 2 && p1.history?.windowStart === "2026-07-01T10:00:00.000Z" && p1.history?.windowEnd === "2026-07-09T09:10:00.000Z",
  JSON.stringify(p1.history)
);

console.log("LEDGER STORE (banked, idempotent, arg-free):");
const evFile = join(ledgerHome, "usage", "events-2026-07.jsonl");
const banked = readFileSync(evFile, "utf8");
check("scan banked the window's 6 events into the monthly file", banked.trim().split("\n").length === 6, banked);
check("skill args never reach the ledger", !banked.includes("SECRET-ARG"));
const prov = JSON.parse(readFileSync(join(ledgerHome, "usage", "provenance.json"), "utf8"));
check("every item got a provenance record at first sighting", p1.items.every((i) => i.id in prov), `have ${Object.keys(prov).length} of ${p1.items.length}`);

const p2 = await buildUiPayload(ctx, { history: true });
check("second scan appends nothing (byte-identical monthly file)", readFileSync(evFile, "utf8") === banked);
const imp2 = p2.items.find((i) => i.name === "impeccable" && i.enabled);
check("second scan reports identical fires", JSON.stringify(imp2?.fires) === JSON.stringify(imp?.fires));
const snapshots = readFileSync(join(ledgerHome, "usage", "snapshots.jsonl"), "utf8").trim().split("\n");
check("one snapshot line per audit run", snapshots.length === 2);
const snap = JSON.parse(snapshots[0]);
check(
  "snapshot records items, enabled, injectedChars and byProvider",
  snap.items === 9 && snap.enabled === 8 && snap.injectedChars === p1.header.injectedChars &&
    snap.byProvider.claude === 6 && snap.byProvider.codex === 2 && snap.byProvider["agents-md"] === 1,
  JSON.stringify(snap)
);

console.log("DEGRADATION (broken ledger, no crash):");
const blocked = join(tmp, "blocked");
writeFileSync(blocked, "a file where a directory was expected");
const p3 = await buildUiPayload({ home, cwd, ledgerHome: blocked }, { history: true });
const imp3 = p3.items.find((i) => i.name === "impeccable" && i.enabled);
check("window figures survive a broken ledger", imp3?.fires?.invocations === 3, JSON.stringify(imp3?.fires));
check("no lifetime claims without a ledger", imp3?.fires?.lifetime === undefined && imp3?.fires?.trackedSince === undefined);
check("no dead-weight or provenance claims without a ledger", p3.header.deadWeightChars === undefined && p3.items.every((i) => i.provenance === undefined));
check("no load-derived fires without a ledger", !("fires" in (p3.items.find((i) => i.source === "agents-md") ?? {})));

console.log("SCAN PATH (auditSource banks; failure is a caveat):");
const ledger2 = join(tmp, "ledger2");
const audit = await auditSource(claudeAdapter, { home, cwd, ledgerHome: ledger2 }, { history: true, strict: false });
check("adapter usage emits ledger events", (audit.history?.events?.length ?? 0) === 4, `${audit.history?.events?.length}`);
const banked2 = readFileSync(join(ledger2, "usage", "events-2026-07.jsonl"), "utf8");
check("auditSource banked the events", banked2.trim().split("\n").length === 4);
const degraded = await auditSource(claudeAdapter, { home, cwd, ledgerHome: blocked }, { history: true, strict: false });
check(
  "a broken ledger degrades to a caveat, history intact",
  (degraded.caveats ?? []).some((c) => /usage ledger unavailable/.test(c)) && (degraded.history?.usage?.length ?? 0) > 0,
  JSON.stringify(degraded.caveats)
);

console.log("OPEN-EVENT (server resolves src; browser sends ids only):");
// A stub `code` CLI so the endpoint never launches a real editor.
const bin = join(tmp, "bin");
mkdirSync(bin, { recursive: true });
const codeLog = join(tmp, "code-log.txt");
writeFileSync(join(bin, "code"), `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho "$@" >> "${codeLog}"\n`);
chmodSync(join(bin, "code"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const ui = await startUiServer(ctx, { history: true });
const api = async (path, body, token = ui.token) => {
  const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token === null ? {} : { "x-context-audit-token": token }),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};
try {
  const served = await api("/api/audit");
  const sImp = served.json?.payload?.items?.find((i) => i.name === "impeccable" && i.enabled);
  const typedEv = sImp?.fires?.events?.[0];
  check("served payload carries the drill-down ids", served.status === 200 && typedEv?.id === "s1:2026-07-09T09:05:00.000Z:impeccable");
  const opened = await api("/api/open-event", { itemId: sImp.id, eventId: typedEv.id });
  check("open-event resolves the ledger src and opens it", opened.status === 200 && opened.json?.ok === true && opened.json?.command === "code", JSON.stringify(opened));
  let logged = "";
  for (let i = 0; i < 40 && !logged.includes("s1.jsonl:5"); i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      logged = readFileSync(codeLog, "utf8");
    } catch {}
  }
  check("editor got --goto file:line for the exact cited line", logged.includes("--goto") && logged.includes("s1.jsonl:5"), logged);
  check("no path travelled from the browser to do it", !JSON.stringify(sImp?.fires?.events).includes(".jsonl"));
  const purged = await api("/api/open-event", { itemId: sImp.id, eventId: "old1" });
  check(
    "a purged transcript is stated, not an error page",
    purged.status === 410 && purged.json?.error === "transcript deleted (event retained)",
    JSON.stringify(purged)
  );
  check("unknown eventId is 404", (await api("/api/open-event", { itemId: sImp.id, eventId: "nope" })).status === 404);
  check("unknown itemId is 404", (await api("/api/open-event", { itemId: "nope", eventId: typedEv.id })).status === 404);
  check("no token is 403", (await api("/api/open-event", { itemId: sImp.id, eventId: typedEv.id }, null)).status === 403);
  const snaps = readFileSync(join(ledgerHome, "usage", "snapshots.jsonl"), "utf8").trim().split("\n");
  check("the server's own scan appended the third snapshot", snaps.length === 3);
} finally {
  ui.server.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall merge checks passed");
process.exit(failures ? 1 : 0);
