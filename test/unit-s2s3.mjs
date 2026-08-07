#!/usr/bin/env node
// Unit corpus for the S2/S3 join (src/ui/inventory.ts) — every per-item facet
// the ledger enrichment adds, and the payload-level rollups beside them,
// asserted against FIXED numbers from one generated fixture:
//   - spread (staple vs one-burst), quiet against the item's own prior gaps
//   - byModel / byEntrypoint / byAgent, and byAgent's absence on agent rows
//   - confusable twins + the sessions they co-fired in
//   - the plugin update boundary over SYMMETRIC windows, install → first fire
//   - refs, disable safety, cross-provider identity, near misses
//   - agent rows: dispatch-tracked, window figures from the ledger, run cost
//     summed from the subagent's own transcript
//   - cursor: tracked only where the store READ, and its window never folded
//     into the merged one
//   - the hook-owned-session exclusion keyed (provider, sessionId)
//   - portfolio / delta / budget cut / growth / superseded / dead weight
//   - two builds of an unchanged fixture produce the same payload
//
// The creed under all of it: absent, tracked-zero and "0 since <date>" are
// three different claims, and each assertion below names which one it wants.
// Everything is written into mkdtemp dirs with an injected home + ledgerHome —
// the real ~/.claude and ~/.context-audit are never read or written.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildUiPayload } = await import(pathToFileURL(join(root, "dist", "ui", "inventory.js")).href);
const { build } = await import(pathToFileURL(join(root, "test", "fixtures", "s2s3", "home.mjs")).href);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};
const json = (x) => JSON.stringify(x);

const tmps = [];
const freshRoot = () => {
  const d = mkdtempSync(join(tmpdir(), "context-audit-s2s3-"));
  tmps.push(d);
  return d;
};

const fx = await build(freshRoot());
const ctx = { home: fx.home, cwd: fx.cwd, ledgerHome: fx.ledgerHome };
const p1 = await buildUiPayload(ctx, { history: true });
const item = (name, kind) => p1.items.find((i) => i.name === name && (kind === undefined || i.kind === kind));
const fires = (name, kind) => item(name, kind)?.fires;
// node:sqlite ships unflagged on Node 22.13+/23.4+ only, and this package
// supports Node 18 — so on the older runtime the fixture writes no Cursor store
// and the rule row is UNTRACKED (which is itself the invariant the degraded
// block at the bottom pins). Three figures move with it and are written as
// arithmetic rather than as a second set of magic numbers, so the reader can
// see which ones and by how much: the rule row's tracking, the two cursor
// conversations in the session denominator, and the three attachments in the
// banked line count.
const CURSOR = fx.cursorReadable ? 1 : 0;

// --- header: what the whole fixture adds up to ------------------------------
console.log("HEADER (the denominators every other figure hangs off):");
check("every fixture asset is inventoried exactly once", p1.items.length === 22, `${p1.items.length} items: ${p1.items.map((i) => i.name).join(", ")}`);
check(
  "tracked counts every dispatch-tracked row — skills, commands, agents, prompts, cursor rules",
  p1.header.tracked === 20 + CURSOR && p1.header.items - p1.header.tracked === 2 - CURSOR,
  `tracked ${p1.header.tracked} of ${p1.header.items}`
);
check(
  "the codex instructions file is untracked — nothing dispatches it, so it gets no zero",
  item("~/.codex/AGENTS.md")?.fires === undefined && !("fires" in (item("~/.codex/AGENTS.md") ?? {})),
  json(item("~/.codex/AGENTS.md")?.fires)
);
check("neverFired counts tracked rows whose lifetime is a measured zero", p1.header.neverFired === 8, `${p1.header.neverFired}`);
check("nothing in the fixture flags", p1.header.flagged === 0 && p1.header.flaggedHigh === 0);
check("the ledger opened — no degradation caveat", p1.ledgerCaveat === undefined, p1.ledgerCaveat);

// --- spread: staple vs one-burst --------------------------------------------
console.log("SPREAD (staple or tried-and-dropped):");
{
  const s = fires("staple");
  check(
    "twelve weekly fires read as twelve active weeks over twelve tracked weeks",
    json(s?.spread) === json({ activeWeeks: 12, weeksSinceFirst: 12, spanDays: 77, oneBurst: false }),
    json(s?.spread)
  );
  check("weekly bins carry one fire per ISO week, no week doubled", s?.weeklyBins?.length === 12 && s.weeklyBins.every((b) => b.count === 1), json(s?.weeklyBins));
  check("lifetime counts every banked fire and its session", s?.lifetime?.invocations === 12 && s?.lifetime?.sessions === 12, json(s?.lifetime));
  check("lifetime figures carry the ledger horizon as their qualifier", s?.trackedSince === fx.dates.trackedSince, s?.trackedSince);

  const b = fires("one-burst");
  check(
    "four fires inside a day and a half are one burst, not a habit",
    b?.spread?.oneBurst === true && b?.spread?.spanDays === 1,
    json(b?.spread)
  );
  // Both halves of the rule: one data point is not a burst either.
  check("a single fire is never badged as a burst", fires("caller")?.spread?.oneBurst === false, json(fires("caller")?.spread));
}

// --- quiet: silence measured against the item's OWN rhythm ------------------
console.log("QUIET (a gap means nothing without the item's prior gaps):");
{
  const q = fires("quiet-one");
  check(
    "40 days of silence stated beside a 59-day prior gap and the gaps counted",
    json(q?.quiet) === json({ days: 40, longestPriorGapDays: 59, gapsCounted: 2 }),
    json(q?.quiet)
  );
  // The invariant, not just the number: below two fires there is no prior gap
  // to compare a silence against, and printing one would be an invented
  // baseline. caller fired exactly once.
  check(
    "an item with one fire gets NO quiet section (no baseline to compare against)",
    fires("caller")?.quiet === undefined && fires("caller")?.lifetime?.invocations === 1,
    json(fires("caller")?.quiet)
  );
  check("an item that never fired gets no fires object at all, not a quiet zero", item("dead-weight")?.fires === null);
}

// --- who dispatches it ------------------------------------------------------
console.log("MODEL / ENTRYPOINT / SIDECHAIN SPLITS:");
{
  const s = fires("staple");
  check(
    "byModel ranks the dispatching models, descending",
    json(s?.byModel) === json([{ model: "claude-sonnet-5", count: 8 }, { model: "claude-opus-5", count: 4 }]),
    json(s?.byModel)
  );
  check(
    "byEntrypoint keeps interactive, automated and unknown apart",
    json(s?.byEntrypoint) === json({ interactive: 9, automated: 3, unknown: 0 }),
    json(s?.byEntrypoint)
  );
  // Events with no recorded entrypoint are their own bucket — folding them into
  // "interactive" would invent the very split this is asked to measure.
  check(
    "events carrying no entrypoint land in unknown, never in interactive",
    json(fires("one-burst")?.byEntrypoint) === json({ interactive: 0, automated: 0, unknown: 4 }),
    json(fires("one-burst")?.byEntrypoint)
  );
  check("byAgent splits main-thread fires from sidechain ones", json(s?.byAgent) === json({ main: 11, sidechain: 1 }), json(s?.byAgent));
  check("byChannel separates model dispatch from typed dispatch", json(s?.byChannel) === json({ auto: 12, typed: 0 }), json(s?.byChannel));
  check("a typed-only skill reads 0 auto fires, which is a measurement", json(fires("caller")?.byChannel) === json({ auto: 0, typed: 1 }), json(fires("caller")?.byChannel));
  // Loads are neither dispatched nor typed, so the split has nothing to say.
  check("a load-only row gets no channel split rather than two zeros", fires("myrule") !== undefined ? fires("myrule")?.byChannel === undefined : true, json(fires("myrule")?.byChannel));
}

// --- agent rows -------------------------------------------------------------
console.log("AGENT ROWS (dispatch-tracked, and the byAgent trap):");
{
  const a = fires("prober");
  // history.ts deliberately keeps agent launches out of its usage aggregation,
  // so the usage table has no row for them. Reading that miss as a measurement
  // would print "0 in the window" beside a lifetime of 2.
  check(
    "an agent row takes its WINDOW figures from its own ledger events, not from a usage-table miss",
    a?.invocations === 2 && a?.sessions === 2 && a?.lifetime?.invocations === 2,
    json(a)
  );
  // The trap: history.ts writes the SPAWNED agent's id into `agent` on a launch
  // event (it is the only place that id appears). On an agent row the field
  // means "this launch produced agent X", not "this fire happened inside a
  // sidechain" — so computing byAgent here would report every launch as a
  // sidechain fire.
  check(
    "byAgent is NOT computed on an agent row, where the agent field means the SPAWNED agent",
    a?.byAgent === undefined,
    json(a?.byAgent)
  );
  check("a skill row with the same field shape still gets byAgent", fires("staple")?.byAgent !== undefined);
  check("a never-launched agent is tracked-zero, not untracked", item("idle-agent")?.fires === null);
  // Run cost is summed from the agent's OWN transcript: two blocks of one
  // response share a message id and must count once (165 + 35, not 365).
  check(
    "per-agent run cost sums the subagent's own transcript, deduped by message id",
    json(item("prober")?.agentCost) === json({ runs: 1, totalTokens: 200, medianTokens: 200 }),
    json(item("prober")?.agentCost)
  );
  // The second launch has no agentId (its transcript is gone). Pricing it as a
  // zero-token run would report a missing measurement as a cheap one.
  check("a launch whose transcript is gone is not priced at zero", item("prober")?.agentCost?.runs === 1 && a?.lifetime?.invocations === 2);
}

// --- confusable twins -------------------------------------------------------
console.log("CONFUSABLE TWINS (which twin is winning, and do they meet):");
{
  const a = item("review-a");
  const b = item("review-b");
  check(
    "identical descriptions cross-link both rows with each other's lifetime fires",
    json(a?.confusable) === json([{ itemId: b?.id, name: "review-b", fires: 1 }]) &&
      json(b?.confusable) === json([{ itemId: a?.id, name: "review-a", fires: 2 }]),
    json([a?.confusable, b?.confusable])
  );
  check(
    "co-fired sessions count the sessions where the pair actually competed",
    a?.coFiredSessions === 1 && b?.coFiredSessions === 1,
    json([a?.coFiredSessions, b?.coFiredSessions])
  );
  check("items with unique descriptions carry no confusable set", item("staple")?.confusable === undefined && item("staple")?.coFiredSessions === undefined);
}

// --- the plugin update boundary ---------------------------------------------
console.log("PLUGIN UPDATE BOUNDARY (symmetric windows only):");
{
  const packed = fires("pack:packed");
  check(
    "fires since the update are stated against the SAME number of days before it",
    json(packed?.sinceUpdate) === json({ at: fx.dates.packUpdatedAt, days: 20, since: 1, prior: 2 }),
    json(packed?.sinceUpdate)
  );
  const fresh = fires("late:fresh");
  check(
    "a 7-day-old update compares 7 days against 7 days, not against a lifetime",
    json(fresh?.sinceUpdate) === json({ at: fx.dates.lateUpdatedAt, days: 7, since: 0, prior: 1 }),
    json(fresh?.sinceUpdate)
  );
  check(
    "a plugin skill with no fires gets no update comparison at all",
    fires("newbie:arrived") === null && item("newbie:arrived")?.plugin?.lastUpdated !== undefined,
    json(item("newbie:arrived")?.plugin)
  );
  check(
    "the update boundary is lastUpdated, never the install date",
    item("pack:packed")?.plugin?.installedAt !== item("pack:packed")?.plugin?.lastUpdated &&
      packed?.sinceUpdate?.at === item("pack:packed")?.plugin?.lastUpdated,
    json(item("pack:packed")?.plugin)
  );
}

// --- install → first fire ---------------------------------------------------
console.log("INSTALL → FIRST FIRE (only inside observable history):");
{
  check(
    "a plugin installed after tracking began reports the real interval",
    fires("late:fresh")?.installToFirstFire === 15,
    json({ v: fires("late:fresh")?.installToFirstFire, prov: item("late:fresh")?.provenance })
  );
  // pack arrived 130 days ago; tracking begins at 110. Its first RECORDED fire
  // is just the horizon, so the interval would measure when this tool started
  // looking, not how long the user took to reach for the skill.
  check(
    "a plugin installed BEFORE the horizon reports nothing rather than the horizon",
    fires("pack:packed")?.installToFirstFire === undefined &&
      (item("pack:packed")?.provenance?.installedAt ?? "") < fires("pack:packed")?.trackedSince,
    json({ prov: item("pack:packed")?.provenance, since: fires("pack:packed")?.trackedSince })
  );
  // A "first-seen" provenance IS the ledger's own first event: the interval is
  // 0 by construction and says nothing at all.
  check(
    "no item claims an interval derived from a first-seen provenance",
    p1.items.every((i) => !(i.provenance?.source === "first-seen" && i.fires?.installToFirstFire !== undefined)),
    json(p1.items.filter((i) => i.fires?.installToFirstFire !== undefined).map((i) => [i.name, i.provenance?.source]))
  );
}

// --- content health ---------------------------------------------------------
console.log("REFS · DISABLE SAFETY · CROSS-PROVIDER · NEAR MISS:");
{
  const refs = item("with-refs")?.refs;
  check(
    "both referenced paths are checked and the missing one is named with its line",
    refs?.checked === 2 && refs?.missing?.length === 1 && refs.missing[0].path === "reference/absent.md" && refs.missing[0].line > 0,
    json(refs)
  );
  const safety = item("retired")?.disabledSafety;
  check(
    "a disabled skill's date is labeled with the evidence that produced it",
    safety?.disabledAtSource === "ctime" && typeof safety?.disabledAt === "string" && safety?.days === 0,
    json(safety)
  );
  check("attempts since disabling are counted, and this name was not attempted", safety?.attemptsSince === 0, json(safety));
  check("the bodies that still name the disabled skill are listed", json(safety?.referencedBy) === json(["caller"]), json(safety?.referencedBy));
  const cross = item("shared", "skill")?.crossProvider;
  check(
    "the same name under another provider is cross-linked, with a body hash behind `identical`",
    json(cross) === json([{ itemId: item("shared", "prompt")?.id, source: "codex", name: "shared", identical: true }]),
    json(cross)
  );
  check(
    "a typo'd dispatch is attributed to the name it was probably aiming at",
    json(item("staple")?.nearMiss) === json([{ name: "stapel", count: 1 }]),
    json(item("staple")?.nearMiss)
  );
  check(
    "items nothing near-missed carry no nearMiss field (absent, never an empty list)",
    p1.items.filter((i) => i.nearMiss !== undefined).length === 1,
    json(p1.items.filter((i) => i.nearMiss !== undefined).map((i) => i.name))
  );
}

// --- cursor -----------------------------------------------------------------
console.log("CURSOR (tracked only where the store read; its window stays its own):");
if (fx.cursorReadable) {
  const rule = item("myrule");
  check("a cursor rule is tracked once the store has actually been read", rule?.fires?.invocations === 2 && rule?.fires?.lifetime?.invocations === 2, json(rule?.fires));
  check("cursor attachments are recorded as loads, never as model dispatches", rule?.fires?.events?.every((e) => e.channel === "load") === true, json(rule?.fires?.events));
  check(
    "an unattributed conversation renders as (unknown) rather than a fabricated project",
    json(rule?.fires?.byProject) === json([{ name: "(unknown)", count: 2 }]),
    json(rule?.fires?.byProject)
  );
  check(
    "the cursor window is reported per provider",
    p1.providerWindows?.cursor?.start === fx.dates.cursorWindowStart,
    json(p1.providerWindows?.cursor)
  );
  // Invariant 4. The store reaches back ten months while the claude transcripts
  // reach back twenty days: rebasing the merged window on it would turn an
  // honest "none in 20d" into a claim about a period nobody observed.
  check(
    "the cursor window is NEVER folded into the merged history window",
    p1.history?.windowStart === fx.dates.claudeWindowStart && p1.history.windowStart > fx.dates.cursorWindowStart,
    json({ merged: p1.history?.windowStart, cursor: fx.dates.cursorWindowStart })
  );
  check(
    "the merged transcript count excludes the cursor store, which is not a transcript",
    p1.history?.transcriptFiles === 4,
    `${p1.history?.transcriptFiles}`
  );
  check(
    "the undocumented-schema caveat rides along with every cursor figure",
    (p1.caveats ?? []).some((c) => /undocumented, unversioned SQLite store/.test(c)),
    json(p1.caveats)
  );
} else {
  ok("cursor store checks skipped (this Node has no node:sqlite)");
}

console.log("PER-PROVIDER WINDOWS (each figure against its own harness's window):");
check("claude's window is its transcripts' span", json(p1.providerWindows?.claude) === json({ start: fx.dates.claudeWindowStart, end: fx.dates.claudeWindowEnd }), json(p1.providerWindows?.claude));
check("codex's window is its rollouts' span, held apart from claude's", json(p1.providerWindows?.codex) === json({ start: fx.dates.codexWindow, end: fx.dates.codexWindow }), json(p1.providerWindows?.codex));

// --- hook ownership ---------------------------------------------------------
console.log("HOOK-OWNED SESSIONS (the key is (provider, sessionId), never the bare id):");
const bankedText = () =>
  readdirSync(join(fx.ledgerHome, "usage"))
    .filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => readFileSync(join(fx.ledgerHome, "usage", f), "utf8"))
    .join("");
const bankedAfterFirstBuild = bankedText();
{
  const banked = bankedAfterFirstBuild;
  // 36 lines were seeded; this build added five — the two typed fires the
  // transcript and the rollout carried, and three cursor attachments. The sixth
  // candidate, the transcript's copy of the hook-owned session's typed fire, is
  // the one that must NOT be here.
  check(
    "the scan banked exactly the events it observed, and not the hook-owned duplicate",
    banked.trim().split("\n").length === (fx.cursorReadable ? 41 : 38),
    `${banked.trim().split("\n").length} stored lines`
  );
  // Two harnesses hand out session ids of the same shape. A codex hook watching
  // a codex session says nothing about what a claude transcript recorded.
  check(
    "a CODEX hook's session does not suppress a CLAUDE session of the same id",
    banked.includes(fx.ids.typedFromTranscriptA) && fires("hooked-a")?.lifetime?.invocations === 1,
    json({ banked: banked.includes(fx.ids.typedFromTranscriptA), fires: fires("hooked-a")?.lifetime })
  );
  check(
    "a CLAUDE hook's session does not suppress a CODEX rollout of the same id",
    banked.includes(fx.ids.typedFromRollout) && fires("ship")?.lifetime?.invocations === 2,
    json({ banked: banked.includes(fx.ids.typedFromRollout), fires: fires("ship")?.lifetime })
  );
  // The rule's own purpose, from the other side: same provider, same session —
  // the two writers stamp different clocks into the id, so only the session
  // exclusion keeps one fire from being counted twice.
  check(
    "a claude hook DOES own its own claude session's typed channel",
    !banked.includes(fx.ids.typedFromTranscriptB) && banked.includes(fx.ids.claudeHookOwningSessHB) &&
      fires("hooked-b")?.lifetime?.invocations === 1,
    json({ transcriptCopy: banked.includes(fx.ids.typedFromTranscriptB), fires: fires("hooked-b")?.lifetime })
  );
  // Which copy survived, stated in evidence rather than by count: the
  // transcript's event carries an entrypoint, the hook's does not.
  check(
    "the surviving copy is the hook's on the owned session and the transcript's on the other",
    json(fires("hooked-a")?.byEntrypoint) === json({ interactive: 1, automated: 0, unknown: 0 }) &&
      json(fires("hooked-b")?.byEntrypoint) === json({ interactive: 0, automated: 0, unknown: 1 }),
    json([fires("hooked-a")?.byEntrypoint, fires("hooked-b")?.byEntrypoint])
  );
}

// --- the one-way browser contract -------------------------------------------
// This fixture is the one with real transcript-derived events (a typed fire, a
// rollout prompt, a subagent run), which is exactly where a src pointer or a
// raw ledger id would leak into a payload that goes to a browser.
console.log("BROWSER PROJECTION (digests only, never a transcript path):");
{
  const rows = p1.items.flatMap((i) => i.fires?.events ?? []);
  check("every fire row is present to drill into", rows.length > 0);
  check("event ids are opaque digests, never the ledger id they resolve from", rows.every((e) => /^[0-9a-f]{16}$/.test(e.id)), json(rows.slice(0, 3)));
  check(
    "no fire row carries a src pointer, a transcript path or a session id",
    !/"src"|\.jsonl|sess[A-Z0-9]/.test(json(rows)),
    json(rows.filter((e) => /\.jsonl|sess/.test(json(e))).slice(0, 3))
  );
  check("projects render as display names, never as absolute paths", rows.every((e) => !e.project.includes("/")), json(rows.map((e) => e.project)));
}

// --- portfolio and the payload-level rollups --------------------------------
console.log("PORTFOLIO · DELTA · BUDGET CUT · GROWTH · SUPERSEDED:");
{
  const port = p1.portfolio;
  check("sessions are keyed (provider, id) — two harnesses' ids never pool", port?.sessions === 36 + 2 * CURSOR, `${port?.sessions}`);
  // The sessions in the denominator but not the numerator: one codex session
  // that only LOADED a file plus the two cursor conversations (a load is not an
  // invocation — it says the harness read a file, not that the session reached
  // for a skill), and three sessions whose only fire names something nothing
  // installs (a typo, and two hook events for uninstalled names).
  check(
    "sessions that only loaded a file, or only fired an uninstalled name, count in the denominator alone",
    port?.sessionsWithFires === 32 && port.sessions - port.sessionsWithFires === 4 + 2 * CURSOR,
    json({ withFires: port?.sessionsWithFires, sessions: port?.sessions })
  );
  check(
    "concentration names the fewest dispatch keys carrying ≥80% of fires, with the rows behind it",
    port?.concentration?.items === 7 && port?.concentration?.pct === 82 && port?.concentration?.ids.length >= 7,
    json(port?.concentration)
  );
  check(
    "concentration ids resolve to real rows, so the stat can open its own proof",
    (port?.concentration?.ids ?? []).every((id) => p1.items.some((i) => i.id === id)),
    json(port?.concentration?.ids)
  );
  check("topSpend prices items at injected chars × that provider's sessions, descending", port?.topSpend?.length === 5 && port.topSpend.every((s, k) => s.chars > 0 && (k === 0 || port.topSpend[k - 1].chars >= s.chars)), json(port?.topSpend));
  check("nothing is flagged, so the flagged-by-activity rail is empty rather than absent", json(port?.flaggedByActivity) === "[]");

  check(
    "delta is measured against the newest usable snapshot, not against this scan",
    p1.delta?.since === fx.dates.lastSnapshot && p1.delta?.items === p1.items.length - 12,
    json(p1.delta)
  );
  // A plugin whose lastUpdated moved since that snapshot updated between the
  // two scans; one whose installedAt ALSO moved is a new install, already
  // counted in the items diff.
  check(
    "only a genuine version move counts as an update — a new install does not",
    json(p1.delta?.pluginsUpdated) === json([{ name: "late", to: "1.0.0" }]),
    json(p1.delta?.pluginsUpdated)
  );

  const cut = p1.budgetCut;
  check("the modeled cut replays over every listed skill, most-fired first", cut?.order?.length === 15 && cut.order[0].name === "staple" && cut.order[0].fires === 12, json(cut?.order?.map((o) => `${o.name}:${o.fires}`)));
  check(
    "cumChars is a running total and the drop flag is a prefix rule",
    cut?.order?.every((o, k) => (k === 0 ? o.cumChars === o.chars : o.cumChars === cut.order[k - 1].cumChars + o.chars)) &&
      cut?.order?.every((o) => o.dropped === o.cumChars > cut.budgetChars),
    json(cut?.order?.map((o) => o.cumChars))
  );
  check("a listing under budget has no headroom to reclaim and drops nothing", cut?.headroomChars === 0 && cut?.order?.every((o) => !o.dropped));
  check("the bar and the header percentage are the same figure", cut?.listingChars === p1.header.listing?.chars, json([cut?.listingChars, p1.header.listing?.chars]));
  check(
    "the latest under→over budget crossing is dated from the snapshot history",
    p1.header.listing?.crossedAt === fx.dates.budgetCrossedAt,
    json(p1.header.listing)
  );

  const weeks = p1.growth?.weeks ?? [];
  check("growth emits contiguous ISO weeks so a quiet stretch renders as one", weeks.length > 1 && weeks.every((w, k) => k === 0 || Date.parse(`${w.weekStart}T00:00:00Z`) - Date.parse(`${weeks[k - 1].weekStart}T00:00:00Z`) === 7 * 86400000), json(weeks.map((w) => w.weekStart)));
  check("this scan's own week carries this scan's owned count", weeks.at(-1)?.owned === p1.items.length, json(weeks.at(-1)));
  check(
    "weeks nobody scanned in carry no owned value, and the caption says so",
    weeks.some((w) => w.owned === undefined) && /none is interpolated/.test(p1.growth?.ownedSource ?? ""),
    p1.growth?.ownedSource
  );
  check(
    "the superseded plugin version is reported with its paths, never removed",
    p1.superseded?.length === 1 && p1.superseded[0].plugin === "pack" && p1.superseded[0].active === "2.0.0" &&
      json(p1.superseded[0].versions) === json(["1.0.0"]) && p1.superseded[0].paths.length === 1,
    json(p1.superseded)
  );
}

// --- dead weight ------------------------------------------------------------
console.log("DEAD WEIGHT (the empirical age gate):");
{
  const idle = item("pack:idle");
  check("a never-fired item installed before the window is dead weight", p1.header.deadWeightChars === idle?.injectedChars && (idle?.injectedChars ?? 0) > 0, json({ header: p1.header.deadWeightChars, idle: idle?.injectedChars }));
  // Three other rows also never fired. Each is younger than the window, so it
  // is "too new to judge" — counting it would price silence nobody observed.
  check(
    "never-fired items installed INSIDE the window are excluded, not counted",
    ["dead-weight", "newbie:arrived", "with-refs"].every((n) => item(n)?.fires === null) &&
      p1.header.deadWeightChars < (item("dead-weight")?.injectedChars ?? 0),
    json({ deadWeight: p1.header.deadWeightChars, young: item("dead-weight")?.injectedChars })
  );
}

// --- idempotency ------------------------------------------------------------
console.log("IDEMPOTENCY (a second build of an unchanged fixture):");
{
  const p2 = await buildUiPayload(ctx, { history: true });
  // Everything except this build's own clock and the since-last-scan baseline,
  // which MUST move: the first build recorded a snapshot, so the second one is
  // measured against it. That is the feature, not drift — asserted below.
  const stable = (p) => {
    const c = JSON.parse(JSON.stringify(p));
    delete c.generatedAt;
    delete c.tookMs;
    delete c.delta;
    return c;
  };
  const a = stable(p1);
  const b = stable(p2);
  // Name the first divergence rather than dumping two 200KB payloads.
  const firstDiff = (x, y, path = "") => {
    if (json(x) === json(y)) return undefined;
    if (x === null || y === null || typeof x !== "object" || typeof y !== "object") return `${path}: ${json(x)} vs ${json(y)}`;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const d = firstDiff(x[k], y[k], `${path}.${k}`);
      if (d) return d;
    }
    return `${path}: shape differs`;
  };
  check("two builds of the same fixture produce the same payload", json(a) === json(b), firstDiff(a, b));
  check(
    "the second build's baseline is the first build, and nothing else moved",
    p2.delta?.since === p1.generatedAt && p2.delta?.items === 0 && p2.delta?.injectedChars === 0,
    json(p2.delta)
  );
  check(
    "rescanning banks nothing twice — the monthly files are byte-identical",
    bankedText() === bankedAfterFirstBuild,
    `${bankedText().trim().split("\n").length} lines vs ${bankedAfterFirstBuild.trim().split("\n").length}`
  );
}

// --- a degraded provider states itself --------------------------------------
// The counterpart to the cursor block above: the store is there and unreadable
// (a schema change, a lock, a Node without node:sqlite). Its rows must keep an
// honest "no readable history" — an unreadable store is not zero usage, and a
// 0 here is the one answer a reader would act on wrongly.
console.log("DEGRADED CURSOR STORE (untracked, never zeroed):");
{
  const fx2 = await build(freshRoot(), undefined, { cursor: "broken" });
  const p = await buildUiPayload({ home: fx2.home, cwd: fx2.cwd, ledgerHome: fx2.ledgerHome }, { history: true });
  const rule = p.items.find((i) => i.source === "cursor" && i.name === "myrule");
  check("the rule is still discovered and priced", rule !== undefined && rule.injectedChars > 0);
  check(
    "an unreadable store leaves the row UNTRACKED — not tracked-with-zero-fires",
    rule !== undefined && !("fires" in rule),
    json(rule?.fires)
  );
  check("the untracked row is out of the neverFired denominator", p.header.tracked === 20, `${p.header.tracked} of ${p.header.items}`);
  check(
    "the failure that produced the blank is stated, in those words",
    (p.caveats ?? []).some((c) => /cursor history unavailable/.test(c) && /not zero usage/.test(c)),
    json(p.caveats)
  );
  check("no cursor window is claimed from a store that did not read", p.providerWindows?.cursor === undefined, json(p.providerWindows));
  check("the rest of the payload is unaffected by the degraded provider", p.items.length === 22 && p.portfolio !== undefined);
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall s2/s3 join checks passed");
process.exit(failures ? 1 : 0);
