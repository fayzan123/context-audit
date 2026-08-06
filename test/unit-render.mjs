#!/usr/bin/env node
// Unit I — dashboard frontend, ledger surface. Renders the fixture payload in
// plain Node (render.js is DOM-free by contract) and pins every new S1 state:
// lifetime · window fires cells, trend glyphs, inline age facts, the tok/fire
// column, the drawer's provenance / fires / invocations sections, collision
// warnings and purged-event rows. Imports dist/ui/render.js, so it runs after
// a build; CONTEXT_AUDIT_RENDER_JS overrides the module path for pre-build
// verification against a scratch compile.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modPath = process.env.CONTEXT_AUDIT_RENDER_JS ?? join(root, "dist", "ui", "render.js");
const R = await import(pathToFileURL(modPath).href);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

const payload = JSON.parse(
  readFileSync(join(root, "test", "fixtures", "render", "payload.json"), "utf8")
);
const byName = (n) => payload.items.find((i) => i.name === n);
const win = R.usageWindow(payload);
const html = R.renderApp(payload, R.defaultState());
// The transcript total rides into every drawer render, the way main.ts and
// renderApp thread it — the breadth denominator tests depend on it.
const drawerFor = (name, state = R.defaultState()) =>
  R.renderDrawerBody(byName(name), state, win, payload.history.transcriptFiles);

console.log("RENDER unit (ledger surface):");

// --- window sanity: everything below leans on the 41d span ------------------
check("fixture window measures 41d", win.span === "41d", `span: ${win.span}`);
check("window carries the scan stamp as its clock", win.asOf === "2026-08-04T12:00:00.000Z");

// --- fires cell: lifetime · window ------------------------------------------
check(
  "fired cell leads with lifetime and keeps the window share beside it",
  html.includes(`42 <span class="winpart">· 6 in 41d</span>`),
  "lifetime · window cell missing"
);
check(
  "a lifetime-bearing cell's title names both methods and the trackedSince date",
  /<td[^>]*title="[^"]*42 lifetime[^"]*since tracking began 2026-03-01[^"]*different method/.test(html),
  "two-window title missing"
);
check(
  "window count can exceed lifetime without either being hidden",
  html.includes(`0 <span class="winpart">· 2 in 41d</span>`),
  "mirror-count cell wrong"
);

// --- trend glyphs -----------------------------------------------------------
for (const [name, glyph] of [["rising", "↗"], ["flat", "→"], ["quiet", "↘"], ["new", "∗"]]) {
  check(
    `trend "${name}" renders its glyph with the verdict in the title`,
    new RegExp(`class="trend" title="${name}[^"]*"[^>]*>${glyph}`, "u").test(html) ||
      html.includes(`class="trend" title="${name}`) && html.includes(`>${glyph}</i>`),
    `missing ${name} ${glyph}`
  );
}
{
  const t = R.trendOf(byName("hot").fires.weeklyBins, payload.generatedAt);
  check("trendOf: rising = 6 recent vs 1 prior", t?.trend === "rising" && t.recent === 6 && t.prior === 1, JSON.stringify(t));
  check("trendOf: quiet when the last 4 ISO weeks are empty", R.trendOf(byName("typedonly").fires.weeklyBins, payload.generatedAt)?.trend === "quiet");
  check("trendOf: new when every fire is recent", R.trendOf(byName("fresh").fires.weeklyBins, payload.generatedAt)?.trend === "new");
  check("trendOf: flat when recent does not exceed prior", R.trendOf(byName("steady").fires.weeklyBins, payload.generatedAt)?.trend === "flat");
  check("trendOf: no verdict without bins", R.trendOf([], payload.generatedAt) === undefined && R.trendOf(undefined, payload.generatedAt) === undefined);
}

// --- never-fired age fact ---------------------------------------------------
check(
  "a never-fired cell with provenance states the age inline",
  html.includes(">never · installed 62d</td>"),
  "age-inline cell missing"
);
check(
  "an mtime date is called an edit, never an install",
  html.includes(">never · edited 20d</td>") && !html.includes("never · installed 20d"),
  "mtime verb wrong"
);
check(
  "without provenance the cell stays a plain window-qualified 0",
  /<td class="c-num zero" title="[^"]*deleted by Claude Code[^"]*">0<\/td>/.test(html),
  "plain zero cell missing"
);
check(
  "the age cell's title names the provenance chain link",
  /<td[^>]*title="[^"]*file creation time on this machine[^"]*">never/.test(html),
  "provenance source missing from title"
);

// --- tok/fire column --------------------------------------------------------
check(
  "tok/fire header is sortable and window-labeled",
  html.includes(`data-sort="tokPerFire"`) && html.includes(">tok / fire · 41d<"),
  "tok/fire header missing"
);
check(
  "tok/fire = (ambient × sessions + body × fires) ÷ fires",
  R.tokPerFire(byName("hot"), 87) === 2450 && html.includes(`>2,450</td>`),
  `got ${R.tokPerFire(byName("hot"), 87)}`
);
check(
  "zero-fire tok/fire states what was paid instead",
  html.includes("paid 17,400 · never fired"),
  "paid-never cell missing"
);
check(
  "in-window-silent tok/fire stays window-qualified, distinct from never",
  html.includes("paid 6,525 · none in 41d"),
  "paid-none cell missing"
);
check("no cell ever renders Infinity or NaN", !/NaN|Infinity/.test(html));
{
  const asc = R.visibleItems(payload, { ...R.defaultState(), sort: { key: "tokPerFire", dir: 1 } });
  const desc = R.visibleItems(payload, { ...R.defaultState(), sort: { key: "tokPerFire", dir: -1 } });
  const fireless = new Set(["typedonly", "cold", "edited", "plainzero", "style-rule", "AGENTS.md"]);
  const tailNames = (list) => list.slice(-5).map((i) => i.name);
  check(
    "zero-fire and n/a rows sort last ascending, untracked n/a very last",
    tailNames(asc).every((n) => fireless.has(n)) && asc[asc.length - 1].name === "style-rule",
    tailNames(asc).join(",")
  );
  check(
    "zero-fire and n/a rows sort last descending too",
    tailNames(desc).every((n) => fireless.has(n)) && desc[desc.length - 1].name === "style-rule",
    tailNames(desc).join(",")
  );
  check(
    "ratio rows order by the ratio itself",
    asc.findIndex((i) => i.name === "hot") > -1 &&
      asc.filter((i) => !fireless.has(i.name)).length === 5,
    "ratio partition wrong"
  );
}

// --- findings badge fire count ----------------------------------------------
check(
  "the findings badge carries the fire count when both facts exist",
  html.includes("▲ 1 · 42 fires"),
  "badge fire count missing"
);
check(
  "the badge's qualifier names the trackedSince date",
  /<span class="badge[^>]*title="[^"]*since tracking began 2026-03-01[^"]*">▲ 1/.test(html),
  "badge qualifier missing"
);

// --- header dead-weight rent ------------------------------------------------
check(
  "the quiet readout gains the dead-weight rent sub-line",
  html.includes("~31k tok/session on silent items"),
  "rent sub-line missing"
);
check("fmtK compacts figures the way the sub-line needs", R.fmtK(31000) === "31k" && R.fmtK(7750) === "7.8k" && R.fmtK(480) === "480" && R.fmtK(9960) === "10k");
{
  const noLedger = {
    ...payload,
    header: { ...payload.header, deadWeightChars: undefined },
  };
  check(
    "no rent line without the ledger's figure — absent, not zero",
    !R.renderApp(noLedger, R.defaultState()).includes("tok/session on silent items"),
    "rent rendered from nothing"
  );
}

// --- drawer: provenance section ---------------------------------------------
{
  const d = drawerFor("hot");
  check(
    "provenance section states date, age and origin",
    d.includes(">provenance<") && d.includes("2026-03-22") && d.includes("135d ago") && d.includes("claude-plugins-official"),
    "provenance section incomplete"
  );
  check(
    "provenance names which chain link produced the date",
    d.includes("the plugin manifest&#39;s install record"),
    "chain link label missing"
  );
  check(
    "an mtime provenance is labeled last edited",
    drawerFor("edited").includes(">last edited<") && drawerFor("edited").includes("a last edit, not an install date"),
    "mtime drawer label wrong"
  );

  // --- drawer: fires extended ----------------------------------------------
  check(
    "lifetime line carries counts, sessions and trackedSince",
    d.includes("<b>42</b> lifetime invocations across <b>9</b> sessions since tracking began 2026-03-01"),
    "lifetime line wrong"
  );
  check(
    "channel split bar is two-tone with labeled counts",
    d.includes(`class="ch-auto" style="width:93%"`) && d.includes(`class="ch-typed" style="width:7%"`) &&
      d.includes("auto <b>39</b> · typed <b>3</b>"),
    "channel bar wrong"
  );
  check(
    "per-provider lines appear when more than one provider fired it",
    d.includes("claude <b>40</b> · codex <b>2</b>"),
    "provider split missing"
  );
  check(
    "outcomes line appears only because non-ok outcomes exist",
    d.includes("<b>42</b> fires · <b>1</b> errored · <b>1</b> rejected"),
    "outcomes line wrong"
  );
  check(
    "no outcomes line when every launch was ok",
    !drawerFor("steady").includes("errored"),
    "outcomes line rendered without failures"
  );
  check(
    "weekly strip renders one cell per ISO week through the scan week",
    (d.match(/class="wk[" ]/g) ?? []).length === 7 &&
      d.includes(`week of 2026-07-27 — 3 fires`) && d.includes(`class="wk b2"`),
    `cells: ${(d.match(/class="wk[" ]/g) ?? []).length}`
  );
  check(
    "empty weeks are explicit cells, not gaps",
    /class="wk" title="week of 2026-06-29 — 0 fires"/.test(d),
    "gap week not rendered"
  );

  // --- drawer: invocations drill-down --------------------------------------
  check(
    "invocation rows are open-event buttons carrying item and event ids",
    d.includes(`data-open-event="ev-hot-3" data-event-item="id-hot"`),
    "event button wiring missing"
  );
  check(
    "the drill-down states its cap against the lifetime total",
    d.includes("latest 3 of 42 recorded") && d.includes("newest first"),
    "cap line missing"
  );
  check(
    "rows show date, project, channel and outcome markers",
    d.includes(">2026-07-28</span>") && d.includes(">tools</span>") &&
      /<span class="evch">typed<\/span><span class="evmark">error<\/span>/.test(d) &&
      /<span class="evmark">interrupted<\/span>/.test(d),
    "row anatomy wrong"
  );
}

// --- drawer: typed-only, 0-since, purged, collision -------------------------
{
  const d = drawerFor("typedonly");
  check(
    "100% typed is stated in words, not just bar geometry",
    d.includes("never auto-fired") && d.includes("since tracking began 2026-03-01"),
    "never-auto-fired text missing"
  );
  const purged = R.renderDrawerBody(byName("typedonly"), { ...R.defaultState(), purgedEvents: ["ev-typed-1"] }, win);
  check(
    "a purged event row renders disabled with the fact retained",
    /data-open-event="ev-typed-1"[^>]* disabled/.test(purged) &&
      purged.includes("transcript deleted (event retained)"),
    "purged row wrong"
  );
  check(
    "an un-purged render leaves the same row clickable",
    !/data-open-event="ev-typed-1"[^>]* disabled/.test(d),
    "row disabled without a 410"
  );
  const zeroSince = drawerFor("mirror");
  check(
    "a 0-lifetime item says 0 since the tracking date — not a bare 0",
    zeroSince.includes("0 recorded in the durable ledger since tracking began 2026-03-01"),
    "0-since line missing"
  );
  const coll = drawerFor("collide");
  check(
    "collision warning counts the copies and lists the other paths",
    coll.includes("same dispatch name at 2 paths — fires cannot be split between the copies") &&
      coll.includes("/fixture/proj/.claude/skills/collide"),
    "collision block wrong"
  );
  check(
    "no collision warning on collision-free items",
    !drawerFor("hot").includes("cannot be split"),
    "false collision warning"
  );
}

// --- shadowed twins get none of the ledger surface --------------------------
{
  const twin = {
    ...byName("hot"),
    id: "id-twin",
    enabled: false,
    twinPath: "/home/u/.claude/skills/hot",
  };
  const d = R.renderDrawerBody(twin, R.defaultState(), win);
  check(
    "a shadowed twin's drawer shows no lifetime, events or channel split",
    d.includes("shadowed") && !d.includes("lifetime invocation") && !d.includes("data-open-event") && !d.includes("ch-auto"),
    "shadowed twin leaks ledger surface"
  );
}

// --- dead-weight amber shares the header's age gate (#13/#16) ----------------
{
  check(
    "exactly one cost cell earns the dead-weight amber — the age-gated one",
    (html.match(/c-cost dw/g) ?? []).length === 1,
    `dw cells: ${(html.match(/c-cost dw/g) ?? []).length}`
  );
  const coldOnly = R.renderApp({ ...payload, items: [byName("cold")] }, R.defaultState());
  check(
    "amber on: installed before the window start, ≥25% cost, zero fires",
    /c-cost dw/.test(coldOnly) && coldOnly.includes("Dead weight:"),
    "age-gated amber missing"
  );
  const editedOnly = R.renderApp({ ...payload, items: [byName("edited")] }, R.defaultState());
  check(
    "amber suppressed on an item installed after the window start (too new to judge)",
    !/c-cost dw/.test(editedOnly) && !editedOnly.includes("Dead weight:"),
    "too-new item still ambered"
  );
}

// --- never-auto-fired table badge (#18) --------------------------------------
{
  check(
    "a 100%-typed row carries the never-auto-fired badge in the table — once",
    (html.match(/never auto-fired<\/span>/g) ?? []).length === 1,
    `badges: ${(html.match(/never auto-fired<\/span>/g) ?? []).length}`
  );
  check(
    "the table badge is tonal and names the trackedSince qualifier",
    /badge fact" title="every recorded fire was user-typed since tracking began 2026-03-01[^"]*">never auto-fired/.test(html),
    "badge qualifier missing"
  );
  const shadowedTyped = R.renderApp(
    { ...payload, items: [{ ...byName("typedonly"), enabled: false, twinPath: "/x" }] },
    R.defaultState()
  );
  check(
    "a shadowed row gets no never-auto-fired badge",
    !shadowedTyped.includes("never auto-fired"),
    "shadowed row badged"
  );
}

// --- sessions-coverage denominator (#19) -------------------------------------
{
  const d = drawerFor("hot");
  check(
    "the drawer breadth states its denominator: N of M sessions (P%)",
    d.includes("across <b>3</b> of <b>87</b> sessions (3%)"),
    "denominator missing"
  );
  check(
    "renderApp threads the transcript total into the drawer",
    R.renderApp(payload, { ...R.defaultState(), selected: "id-hot" }).includes("of <b>87</b> sessions"),
    "renderApp lost the denominator"
  );
  const bare = R.renderDrawerBody(byName("hot"), R.defaultState(), win);
  check(
    "no denominator is claimed when no transcript total was threaded through",
    bare.includes("across <b>3</b> sessions") && !bare.includes("of <b>87</b>"),
    "fabricated denominator"
  );
  const skew = R.renderDrawerBody(byName("hot"), R.defaultState(), win, 1);
  check(
    "a lagging transcript total is skew-guarded — never over 100%",
    skew.includes("across <b>3</b> of <b>3</b> sessions (100%)"),
    "skew guard failed"
  );
}

// --- interrupted fires stated in full (#29) ----------------------------------
{
  check(
    "the drawer interrupted line carries count, wasted tokens and share",
    drawerFor("hot").includes("interrupted 1× (~1,000 tok, 17% of fires)"),
    "full interrupted fact missing"
  );
  check(
    "the interrupted table badge appears only where interrupts exist",
    html.includes("1 interrupted (~1,000 tok, 17% of fires)</span>") &&
      (html.match(/ interrupted \(~/g) ?? []).length === 1,
    `table badges: ${(html.match(/ interrupted \(~/g) ?? []).length}`
  );
}

// --- backfilled drill-down rows labeled (#17) --------------------------------
{
  const d = drawerFor("typedonly");
  check(
    "a backfilled row is chip-labeled and opens history.jsonl honestly",
    /data-open-event="ev-typed-0"[^>]*title="open history.jsonl at this imported entry"/.test(d) &&
      /data-open-event="ev-typed-0"[\s\S]*?<span class="evmark">backfilled<\/span>/.test(d),
    "backfill labeling missing"
  );
  const observed = d.slice(d.indexOf("ev-typed-1"), d.indexOf("ev-typed-0"));
  check(
    "an observed row keeps its transcript title and gains no chip",
    observed.includes("open the transcript at this invocation") && !observed.includes("backfilled"),
    "observed row mislabeled"
  );
  check(
    "the caption hedges to source record only when imports are listed",
    d.includes("each row opens its source record at the line") &&
      drawerFor("hot").includes("each row opens its transcript at the line"),
    "caption hedge wrong"
  );
}

// --- quiet-onset budget annotation (#20) -------------------------------------
{
  check(
    "a quiet row near the crossing carries the annotation in its trend note",
    html.includes("last fired 90d ago — around when your skill listing went over budget (2026-05-10)"),
    "table annotation missing"
  );
  const d = drawerFor("typedonly");
  check(
    "the drawer states the annotation and ticks the crossing week",
    d.includes("around when your skill listing went over budget") &&
      /class="wk b3 crossed" title="week of 2026-05-04 — 7 fires · skill listing went over budget 2026-05-10"/.test(d) &&
      d.includes("outlined cell = skill listing went over budget"),
    "drawer annotation or tick missing"
  );
  const far = {
    ...payload,
    header: {
      ...payload.header,
      listing: { ...payload.header.listing, crossedAt: "2026-07-30T00:00:00Z" },
    },
  };
  check(
    "no annotation when the crossing sits far from the quiet onset",
    !R.renderApp(far, R.defaultState()).includes("around when your skill listing"),
    "annotation overclaims proximity"
  );
  const noCross = {
    ...payload,
    header: { ...payload.header, listing: { ...payload.header.listing } },
  };
  delete noCross.header.listing.crossedAt;
  check(
    "no annotation and no tick without a recorded crossing",
    !R.renderApp(noCross, R.defaultState()).includes("around when your skill listing") &&
      !R.renderDrawerBody(byName("typedonly"), R.defaultState(), R.usageWindow(noCross), 87).includes("crossed"),
    "annotation fabricated from nothing"
  );
}

// --- readBy line (#7) --------------------------------------------------------
{
  check(
    "readBy renders in the drawer even for a fire-less item",
    drawerFor("AGENTS.md").includes("read by codex"),
    "readBy line missing"
  );
  check(
    "no readBy line without the field",
    !drawerFor("hot").includes("read by "),
    "readBy fabricated"
  );
}

// --- per-project chips (#6) --------------------------------------------------
{
  const d = drawerFor("hot");
  check(
    "per-project chips list display names and counts, descending",
    /<span class="pchip">context-audit <b>30<\/b><\/span> <span class="pchip">tools <b>12<\/b><\/span>/.test(d) &&
      d.includes("lifetime fires per project"),
    "project chips missing"
  );
  check(
    "no project line without byProject",
    !drawerFor("steady").includes("pchip"),
    "fabricated project line"
  );
}

// --- escaping ----------------------------------------------------------------
{
  const hostile = {
    ...byName("hot"),
    id: "id-hostile",
    provenance: { installedAt: "2026-03-22T00:00:00Z", source: "plugin-manifest", origin: "<b>evil</b>" },
    collision: { paths: ['</ul><script>alert(1)</script>'] },
    fires: {
      ...byName("hot").fires,
      byProject: [{ name: "<img src=x onerror=alert(1)>", count: 1 }],
      events: [{ id: "ev-x", ts: "2026-08-01T09:00:00Z", project: "<img src=x onerror=alert(1)>", channel: "auto" }],
    },
  };
  const d = R.renderDrawerBody(hostile, R.defaultState(), win);
  check(
    "hostile payload strings in the new sections render escaped",
    !d.includes("<img src=x") && !d.includes("<script>alert") && !d.includes("<b>evil</b>"),
    "unescaped interpolation"
  );
}

// ============================================================================
// S2 / S3 surfaces — second fixture.
//
// payload-s2.json carries everything the S1 fixture has no field for: the
// portfolio strip, the since-last-scan delta, the four analysis panels, and
// the drawer's content-health / relationships / plugin / since-disabling
// sections. It is a SEPARATE file on purpose — the assertions above count
// badges and amber cells across the whole S1 payload, and growing that fixture
// would move those counts without any of the new code being wrong.
//
// Everything below is an HONESTY assertion: each one names a claim the tool
// must never make, and the test fails if the markup makes it. Absence, a
// window, or a stated method — never a fabricated zero.
// ============================================================================
const p2 = JSON.parse(
  readFileSync(join(root, "test", "fixtures", "render", "payload-s2.json"), "utf8")
);
const clone = (o) => JSON.parse(JSON.stringify(o));
const win2 = R.usageWindow(p2);
const drawer2 = (id, payload = p2, state = R.defaultState()) =>
  R.renderDrawerBody(
    payload.items.find((i) => i.id === id),
    state,
    R.usageWindow(payload),
    payload.history.transcriptFiles
  );
const app2 = R.renderApp(p2, R.defaultState());
/** One table row's markup, by item id — badge counts are per-row facts. */
const rowOf = (html, id) => {
  const t = html.slice(html.indexOf(`<table class="inv"`));
  const i = t.indexOf(`data-id="${id}"`);
  return i < 0 ? "" : t.slice(i, t.indexOf("</tr>", i));
};
/** One engraved drawer section, by its label. */
const sectionOf = (html, label) => {
  const i = html.indexOf(`<span class="engr">${label}</span>`);
  return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i));
};
/** A panel rendered through the real results path, exactly as the page does. */
const panelOf = (payload, key, extra = {}) =>
  R.renderResults(payload, { ...R.defaultState(), panel: key, ...extra });
/** Just the panel's own box, so "no axis" assertions can't be fooled by chrome. */
const panelBox = (html) => {
  const i = html.indexOf(`<section class="panelbox`);
  return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i) + 10);
};
const countOf = (html, re) => (html.match(re) ?? []).length;

console.log("\nRENDER unit (S2/S3 surfaces):");

check("second fixture measures the same 41d window", win2.span === "41d", win2.span);

// --- entrypoint: absent is not zero (#S2 dispatch) ---------------------------
{
  const d = drawer2("id-blind");
  check(
    "an all-unknown byEntrypoint says the entrypoint was not recorded, with the count",
    d.includes("Entrypoint not recorded — not one of this item's 9 recorded fires carries one"),
    "absence not stated"
  );
  check(
    "it names the failure it is refusing: a gap in the record, not 0% automated",
    d.includes("A gap in the record, not 0% automated."),
    "disclaimer missing"
  );
  check(
    "no split is drawn from nothing — neither bucket renders a 0",
    !/interactive <b>0<\/b>/.test(d) && !/automated <b>0<\/b>/.test(d),
    "invented split"
  );
  const split = clone(p2);
  split.items.find((i) => i.id === "id-blind").fires.byEntrypoint = {
    interactive: 6,
    automated: 2,
    unknown: 1,
  };
  const ds = drawer2("id-blind", split);
  check(
    "a recorded split renders both buckets and keeps unknown out of them",
    ds.includes("interactive <b>6</b> · automated <b>2</b> · not recorded <b>1</b>") &&
      !ds.includes("Entrypoint not recorded"),
    "split line wrong"
  );
}

// --- bundled files: a zero denominator is not a 0% (#S3) ---------------------
{
  const d = drawer2("id-blind");
  const health = sectionOf(d, "content health");
  // By its own line, not by a path index: both bundled paths also appear in the
  // refs list above, so slicing on the path name would slice the wrong block.
  const bfLines = [...health.matchAll(/<p class="factline bfline"[\s\S]*?<\/p>/g)].map((m) => m[0]);
  const zeroLine = bfLines.find((l) => l.includes("reference/typography.md")) ?? "";
  check(
    "{readInFires:0, ofFires:0} renders in words: read, but never during a fire",
    zeroLine.includes("read, but never during a fire"),
    "zero-denominator wording missing"
  );
  check(
    "that line draws no share bar and states no percentage",
    !zeroLine.includes(`class="share"`) && !/\d%/.test(zeroLine),
    "a share was drawn over an absent denominator"
  );
  check(
    "its method says why there is no share to take",
    health.includes("There is no share to take."),
    "method line missing"
  );
  check(
    "a measured file states both sides of the share and draws its bar",
    health.includes("<b>3</b> of 4 fire sessions") && health.includes(`<i style="width:75%">`),
    "measured bundled line wrong"
  );
  check(
    "both sides of that share are named as window figures, not lifetime",
    health.includes("Both sides of that share come from the transcript window, not the ledger's lifetime."),
    "share window qualifier missing"
  );
}

// --- update relevance: absent is UNKNOWN, never "unchanged" (#S3) ------------
{
  const d = drawer2("id-plug");
  check(
    "a newer listed version with nothing cached to compare renders as unknown",
    d.includes("Would updating change this item? Unknown — 7.0.0 is listed by the local marketplace but is not cached on this machine"),
    "unknown line missing"
  );
  check(
    "and says outright that unknown is not unchanged",
    d.includes("Unknown is not &quot;unchanged&quot;."),
    "the distinction is not stated"
  );
  check(
    "no comparison verdict is rendered without a comparison",
    !d.includes("byte-identical") && !d.includes("up to date") && !d.includes("would leave this item"),
    "a verdict was invented"
  );
  const same = clone(p2);
  same.items.find((i) => i.id === "id-plug").updateRelevance = {
    version: "7.0.0",
    identical: true,
  };
  const diff = clone(p2);
  diff.items.find((i) => i.id === "id-plug").updateRelevance = {
    version: "7.0.0",
    identical: false,
    changedFiles: 3,
  };
  check(
    "a real byte comparison renders its verdict either way",
    drawer2("id-plug", same).includes("updating to the cached <b>7.0.0</b> would leave this item byte-identical") &&
      drawer2("id-plug", diff).includes("the cached <b>7.0.0</b> differs in <b>3</b> files of this item"),
    "updateRelevance verdicts wrong"
  );
  check(
    "the comparison names its method — file contents, not version numbers",
    drawer2("id-plug", diff).includes("A byte comparison against the newest version of this plugin still in the local cache — file contents, not version numbers."),
    "method missing"
  );
}

// --- per-agent run cost: method and denominator, always (#S2 carve-out) ------
{
  const priced = drawer2("id-agent-priced");
  check(
    "run cost renders total and median",
    priced.includes(`<b>184,320</b> tok total · median <b>88,000</b> tok`),
    "run cost figures missing"
  );
  check(
    "the figure never appears without the method that produced it",
    priced.includes("Total tokens processed (input + output + cache creation + cache read), summed from each run&#39;s own subagents/agent-&lt;id&gt;.jsonl") &&
      priced.includes("a token count, not a bill"),
    "method string missing"
  );
  check(
    "and never without its denominator",
    priced.includes("Priced 2 of 5 recorded launches") &&
      priced.includes("a launch whose subagent transcript is gone is left unpriced rather than counted as a zero-token run"),
    "denominator missing"
  );
  const bare = drawer2("id-agent-bare");
  check(
    "an agent whose runs were purged says unpriced — never a 0",
    bare.includes("Run cost unpriced — none of the 3 recorded launches still has its own") &&
      bare.includes("Unmeasured, which is not the same as zero.") &&
      !bare.includes(">run cost<") &&
      !/<b>0<\/b> tok total/.test(bare),
    "unpriced agent rendered a zero"
  );
  const noCount = clone(p2);
  const nc = noCount.items.find((i) => i.id === "id-agent-priced");
  delete nc.fires;
  check(
    "with no launch count to divide by, the denominator is refused rather than faked",
    drawer2("id-agent-priced", noCount).includes("Priced 2 runs — one per surviving subagent transcript. This payload states no launch count to price them against."),
    "fake denominator"
  );
  check(
    "a non-agent row is never given an unpriced-run note",
    !drawer2("id-blind").includes("Run cost unpriced"),
    "run-cost note leaked onto a skill"
  );
}

// --- delta: an unrecorded previous version is said in words (#S2) ------------
{
  check(
    "a pluginsUpdated entry with no `from` states that the previous version was not recorded",
    app2.includes("superpowers updated to 6.2.0 (previous version not recorded)"),
    "no-from wording missing"
  );
  check(
    "no sentinel is printed where a version would go",
    !/unknown\s*→/i.test(app2) && !/undefined/.test(app2) && !/\?\s*→\s*6\.2\.0/.test(app2),
    "a sentinel reads as a version"
  );
  check(
    "an entry that HAS a from still renders the real transition",
    app2.includes("impeccable 1.2.0 → 1.3.0"),
    "from → to missing"
  );
  check(
    "the delta names the snapshot it was measured against and why `from` can be absent",
    app2.includes("snapshots record no plugin versions, which is why a previous version can be unrecorded"),
    "delta method missing"
  );
}

// --- portfolio: concentration counts dispatch names, not rows ----------------
{
  check(
    "concentration prints the dispatch-name count",
    app2.includes(`<span class="rfig">2<i>names</i></span>`) &&
      app2.includes("account for 84% of every recorded fire"),
    "name count missing"
  );
  check(
    "it never prints ids.length as the count",
    !/<span class="rfig">3<i>names?<\/i>/.test(app2),
    "row count printed as a name count"
  );
  check(
    "the row count is stated separately, with the reason the two differ",
    app2.includes("opens 3 rows — one name is installed at two scopes"),
    "row-count note missing"
  );
  const f = R.focusSet(p2, "concentration");
  check(
    "the proof view's label carries the name count and its set carries every row",
    f?.label === "top 2 by fires" && f.ids.length === 3,
    JSON.stringify(f)
  );
  check(
    "a top-spend entry whose row is not in this payload renders as text, not a dead button",
    app2.includes(`<span class="rlink">ghost `) && !app2.includes(`data-id="id-ghost"`),
    "unresolvable stat offered a click"
  );
  check(
    "the two rent figures are held apart by unit — window total vs per-session",
    app2.includes("a WINDOW TOTAL over the observed history") &&
      app2.includes("The header&#39;s silent-item rent is a PER-SESSION figure"),
    "spend/rent units conflated"
  );
}

// --- growth: a week with no owned observation is a GAP, never a join ---------
{
  const g = panelBox(panelOf(p2, "growth"));
  const paths = [...g.matchAll(/<path class="gw-step" d="([^"]+)"/g)].map((m) => m[1]);
  check(
    "the owned line is drawn as one path per contiguous run of observations",
    paths.length === 2,
    `paths: ${paths.length}`
  );
  // Geometry-independent: the gap tick marks the unobserved week, and a path
  // that interpolated across it would have to carry x coordinates on both
  // sides of that tick.
  const gapX = Number(/<line class="gw-gap" x1="([\d.]+)"/.exec(g)?.[1]);
  const xsOf = (d) => [...d.matchAll(/[MH]\s(-?[\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "no path spans the unobserved week — the gap is a break, not an interpolation",
    Number.isFinite(gapX) &&
      !paths.some((d) => xsOf(d).some((x) => x < gapX) && xsOf(d).some((x) => x > gapX)),
    paths.join(" | ")
  );
  check(
    "the gap week is ticked on the axis so missing data reads as missing",
    countOf(g, /class="gw-gap"/g) === 1,
    `ticks: ${countOf(g, /class="gw-gap"/g)}`
  );
  check(
    "observation dots appear only on weeks that carry one",
    countOf(g, /class="gw-obs"/g) === 4,
    `dots: ${countOf(g, /class="gw-obs"/g)}`
  );
  check(
    "the gap week's own readout states the absence",
    g.includes("no owned observation this week"),
    "gap tooltip missing"
  );
  check(
    "the caption refuses interpolation in words",
    g.includes("breaks over the <b>1</b> week with none — ticked on the axis") &&
      g.includes("Nothing is interpolated across a gap: joining them would draw a history the snapshots never recorded."),
    "caption missing"
  );
  check(
    "each series names the method it came from, beside the series",
    g.includes("owned<i>scan snapshots, from the first recorded run forward</i>") &&
      g.includes("distinct items with at least one recorded fire that week — durable ledger events"),
    "series captions missing"
  );
}

// --- overlap: each column carries its OWN window; empty is not zero ----------
{
  const o = panelBox(panelOf(p2, "overlap"));
  check(
    "every provider column head carries that provider's own readable history",
    o.includes(`<span class="ovl-prov">claude</span>\n        <span class="ovl-win">2026-06-24 → 2026-08-04</span>`) &&
      o.includes(`<span class="ovl-prov">codex</span>\n        <span class="ovl-win">2026-03-03 → 2026-08-04</span>`) &&
      o.includes(`<span class="ovl-prov">cursor</span>\n        <span class="ovl-win">2026-05-12 → 2026-08-03</span>`),
    "per-provider window heads missing"
  );
  check(
    "and the caption says why the columns are not like-for-like",
    o.includes("Each column states its own provider's window, because the stores keep different amounts of history and the counts are not like-for-like."),
    "window caption missing"
  );
  check(
    "a provider with no record of an asset gets an empty cell, never a 0",
    countOf(o, /class="ovl-cell void"/g) === 1 &&
      o.includes(`<span class="sr">no record</span>`) &&
      o.includes("An empty cell is an absent observation, not a zero."),
    "void cell wrong"
  );
  // A harness holding its own COPY of the asset is not "no record" — the cell
  // that used to render "·" there was denying the very duplication this panel
  // is for. It reports the copy's own fires, taken from the copy's own row.
  check(
    "a harness holding a separate copy reports the copy, not an empty cell",
    countOf(o, /class="ovl-cell copy"/g) === 1 &&
      o.includes("A separate copy of") &&
      o.includes("Each harness loads and pays for its own copy."),
    "copy cell wrong"
  );
  check(
    "no cell in the matrix prints a zero at all",
    !/ovl-cell[^>]*>(<b>)?0/.test(o),
    "a zero reached the matrix"
  );
  check(
    "a reader that dispatches nothing says read, and says why that is expected",
    o.includes(`class="ovl-cell read"`) &&
      o.includes("an instruction file is read, not dispatched, so that is expected rather than a silence worth acting on"),
    "read cell wrong"
  );
  check(
    "a cross-provider twin is marked with its body comparison",
    o.includes(`class="ovl-twin"`) && o.includes("AGENTS.md also exists under cursor — byte-identical body"),
    "twin marker missing"
  );
  const noWin = clone(p2);
  delete noWin.providerWindows;
  const o2 = panelBox(panelOf(noWin, "overlap"));
  check(
    "without per-provider windows every column is labelled with the one shared window",
    countOf(o2, /class="ovl-win shared">since 2026-03-01/g) === 3 &&
      o2.includes("Every column shares one window (since 2026-03-01): this payload carries no per-provider retention dates, so the columns are not like-for-like and are not labelled as if they were."),
    "shared-window fallback wrong"
  );
  check(
    "the fallback never dresses one merged window up as three measured ones",
    !o2.includes(`<span class="ovl-win">`),
    "merged window rendered as per-provider"
  );
}

// --- refs: a fact to check, not a defect to alarm about ----------------------
{
  const d = drawer2("id-blind");
  const health = sectionOf(d, "content health");
  check(
    "refs state the denominator, the misses and the exec-bit count",
    health.includes("<b>5</b> referenced paths checked · <b>1</b> did not resolve · <b>1</b> without an exec bit"),
    "refs line wrong"
  );
  check(
    "each unresolved path carries the SKILL.md line to go look at",
    health.includes(`<span class="refpath">reference/missing-guide.md</span> <span class="dim">SKILL.md:12</span>`),
    "ref location missing"
  );
  check(
    "the method admits a missing file and an example path are indistinguishable",
    health.includes("a path an example tells you to create reads exactly the same way as one that should already be there. Something to check at the line, not a defect."),
    "refs method missing"
  );
  check(
    "refs render tonal — no severity class anywhere in content health",
    !/\bdgr\b|\bsig\b|badge|danger|warn/.test(health),
    "refs carry a severity signal"
  );
  check(
    "and no ref fact ever reaches the table as a badge",
    !app2.includes("did not resolve") && !app2.includes("refpath"),
    "refs badged the table"
  );
}

// --- table facts: one burst, and the scope it all landed in ------------------
{
  check(
    "a one-burst item that is no longer new carries the tried & dropped badge — once",
    countOf(app2, /tried &amp; dropped/g) === 1 &&
      rowOf(app2, "id-burst-old").includes("tried &amp; dropped"),
    `badges: ${countOf(app2, /tried &amp; dropped/g)}`
  );
  check(
    "the badge's title states the span, the silence and the record it was measured over",
    /all 4 recorded fires landed within one 3-day span \(2026-05-05 → 2026-05-08\), and nothing since — 88d ago\. Measured over the ledger&#39;s record since 2026-03-01\./.test(app2),
    "burst title incomplete"
  );
  check(
    "a one-burst item whose burst is still recent is called new, never dropped",
    rowOf(app2, "id-burst-new").includes("∗") &&
      !rowOf(app2, "id-burst-new").includes("tried &amp; dropped"),
    "a fresh item was called dropped"
  );
  check(
    "the drawer states the burst span either way",
    drawer2("id-burst-new").includes("one burst — every fire inside <b>2d</b>, active in <b>1</b> of 1 week since its first fire"),
    "spread line missing on the new item"
  );
  check(
    "a multi-week item's spread reads as a span, not a burst",
    !drawer2("id-plug").includes("one burst"),
    "burst wording on a staple"
  );
  check(
    "the quiet line compares the silence against this item's own longest gap",
    drawer2("id-burst-old").includes("quiet <b>88d</b> · longest prior gap <b>2d</b> <span class=\"dim\">over 3 gaps</span>"),
    "quiet line wrong"
  );
  check(
    "the scope badge names the one project every fire landed in — once",
    countOf(app2, /only in context-audit/g) === 1 &&
      rowOf(app2, "id-scoped").includes(`>only in context-audit</span>`),
    `scope badges: ${countOf(app2, /only in context-audit/g)}`
  );
  check(
    "its title states the asymmetry: paid everywhere, used in one place",
    app2.includes("Its always-in-context cost is paid in every session in every project; its recorded use is in that one."),
    "scope asymmetry not stated"
  );
  check(
    "the drawer repeats the scope fact and the same-name-at-another-scope fact",
    drawer2("id-scoped").includes("every recorded fire landed in one project") &&
      drawer2("id-scoped").includes("the same dispatch name also exists at <b>project</b> scope"),
    "scope block wrong"
  );
  check(
    "a near-miss is a count of names that resolved to nothing, never folded into fires",
    drawer2("id-scoped").includes(`<span class="pchip">/scopedone <b>2</b></span>`) &&
      drawer2("id-scoped").includes("fired, matched nothing installed"),
    "near-miss block wrong"
  );
  check(
    "a confusable twin states its own fire count and whether they ever co-fired",
    drawer2("id-scoped").includes(`<span class="pchip">blindspot <b>9</b></span>`) &&
      drawer2("id-scoped").includes("No recorded session fired this one and a twin together."),
    "confusable block wrong"
  );
}

// --- since disabling: an upper bound, labelled as one ------------------------
{
  const d = drawer2("id-off");
  check(
    "the disable date is stated as a bound, not a record",
    d.includes(`off since <b>2026-06-15</b> or earlier <span class="dim">· at least 50d</span>`),
    "disable date wording wrong"
  );
  check(
    "the ctime source is named, with what else moves it",
    d.includes("That date is the directory&#39;s ctime: moving a skill into skills-disabled is a rename, which leaves mtime alone but bumps ctime") &&
      d.includes("Treat it as an upper bound on the date"),
    "ctime caveat missing"
  );
  check(
    "attempts since are counted, and what an attempt means is stated",
    d.includes("<b>2</b> attempted invocations of this name since") &&
      d.includes("an attempt is something that went looking and found it gone"),
    "attempts line wrong"
  );
  check(
    "the other assets that still name it are listed, not just counted",
    d.includes("named in the body of <b>2</b> other items") &&
      d.includes("<li>superpowers:brainstorming</li>") &&
      d.includes("Disabling it does not update them."),
    "referenced-by list missing"
  );
  const undated = clone(p2);
  const u = undated.items.find((i) => i.id === "id-off");
  delete u.disabledSafety.disabledAt;
  delete u.disabledSafety.disabledAtSource;
  delete u.disabledSafety.days;
  const du = drawer2("id-off", undated);
  check(
    "with no disable date the section still counts attempts and invents no date",
    du.includes("attempted invocations of this name since") && !du.includes("off since"),
    "a date was fabricated"
  );
}

// --- plugin group: superseded versions reported, never deleted ---------------
{
  check(
    "the group row states how many superseded versions sit on disk, which, and how big",
    app2.includes("2 superseded on disk · 5.1.0, 6.1.1 · 3.8 MB"),
    "superseded line missing"
  );
  check(
    "its title names the live version, prints the paths, and disclaims deleting them",
    app2.includes("6.2.0 is the live one. Reported, never deleted; remove them yourself if you want the space back.") &&
      app2.includes("/home/u/.claude/plugins/cache/superpowers/5.1.0"),
    "superseded title wrong"
  );
  check(
    "a newer listed version is a claim about the LOCAL checkout only",
    app2.includes(`<span class="upd">7.0.0 listed</span>`) &&
      app2.includes("the local marketplace lists 7.0.0"),
    "newer-listed wording wrong"
  );
}

// --- payload caveats: degraded reads state themselves ------------------------
{
  check(
    "payload caveats are counted and read in full on hover",
    app2.includes(">2 caveats<") &&
      app2.includes("Cursor&#39;s local conversation store could not be opened (SQLITE_CANTOPEN)") &&
      app2.includes("3 ledger lines were unreadable and were skipped."),
    "caveat strip wrong"
  );
  // They qualify the SCAN, not the current filter, so they sit in the masthead
  // plate beside the scan stamp and window rather than in the filter rail.
  check(
    "caveats sit in the masthead plate, beside the scan facts they qualify",
    /<div class="plate">[\s\S]*?>2 caveats<[\s\S]*?<\/div>/.test(app2) &&
      !/<div class="rail">[\s\S]*?>2 caveats<[\s\S]*?<\/div>/.test(app2),
    "caveats not in the plate"
  );
  const one = clone(p2);
  one.caveats = ["one thing went wrong"];
  check(
    "one caveat is singular",
    R.renderApp(one, R.defaultState()).includes(">1 caveat<"),
    "plural wrong"
  );
  const none = clone(p2);
  delete none.caveats;
  check(
    "no caveat strip when the payload states none — absent, not a zero",
    !R.renderApp(none, R.defaultState()).includes("caveat on these figures") &&
      !R.renderApp(none, R.defaultState()).includes("caveats on these figures"),
    "empty caveat chrome"
  );
}

// --- panel empty states: teaching, never an empty axis -----------------------
{
  const teaches = (name, html, phrases) => {
    const box = panelBox(html);
    check(
      name,
      box.includes("panel-void") &&
        box.includes("panel-empty") &&
        phrases.every((p) => box.includes(p)) &&
        !box.includes(`<svg class="chart`) &&
        !box.includes(`class="grid"`) &&
        !box.includes(`class="ax-line"`),
      box.slice(0, 240)
    );
  };

  teaches(
    "prune: nothing in view says so and offers the way back",
    panelOf(p2, "prune", { query: "zzzz" }),
    ["nothing to plot in this scope", "the filters on the rail are hiding all of them", "data-clear"]
  );

  const noFires = clone(p2);
  noFires.items = noFires.items.map((i) => ({ ...i, fires: null }));
  teaches(
    "prune: no fires anywhere draws no axis and states the reading instead",
    panelOf(noFires, "prune"),
    [
      "no fires to plot against",
      "so the horizontal axis has no range — every mark would sit on the same line",
      "is being paid across them with nothing recorded against it",
    ]
  );

  const noCut = clone(p2);
  delete noCut.budgetCut;
  teaches(
    "budget: a listing with no modelled drop order says which fact is missing",
    panelOf(noCut, "budget"),
    ["drop order not modelled", "It needs fire counts to rank on; a scan with no readable history cannot produce it."]
  );

  const noListing = clone(noCut);
  delete noListing.header.listing;
  check(
    "budget: a machine subject to no listing is never offered the panel at all",
    !panelOf(noListing, "budget").includes(`data-panel-to="budget"`) &&
      panelOf(noListing, "budget").includes(`<table class="inv"`),
    "a Claude-only mechanic was offered to a machine without it"
  );

  teaches(
    "overlap: shared assets outside the current scope say so and offer the scope",
    panelOf(p2, "overlap", { mode: "skills" }),
    ["shared assets sit outside this scope", "An AGENTS.md read by two harnesses is the usual case", `data-mode="all"`]
  );

  const unshared = clone(p2);
  unshared.items = unshared.items.map((i) => {
    const c = { ...i };
    delete c.readBy;
    // crossProvider counts as sharing too — the same dispatch name under two
    // harnesses is the overlap most machines actually have, and it is paid for
    // once per harness. Leaving it in place here would leave the matrix
    // populated and never reach the empty state this case is about.
    delete c.crossProvider;
    if (c.fires) delete c.fires.byProvider;
    return c;
  });
  teaches(
    "overlap: nothing shared is a real reading, and says which one",
    panelOf(unshared, "overlap"),
    ["nothing is shared", "no dispatch name exists under two harnesses", "not a guarantee that no file is duplicated"]
  );
  // The panel must never claim more than its evidence: only two things leave a
  // cross-provider record anywhere, so "nothing found" is not "nothing exists".
  check(
    "the empty matrix does not claim nothing is paid for twice",
    !panelOf(unshared, "overlap").includes("nothing is being paid for twice"),
    "empty state still over-claims"
  );

  const solo = clone(unshared);
  solo.items = solo.items.filter((i) => i.source === "claude");
  teaches(
    "overlap: one provider on the machine explains what would fill the panel",
    panelOf(solo, "overlap"),
    ["one provider on this machine", "An overlap matrix compares what two or more harnesses read"]
  );

  const noGrowth = clone(p2);
  delete noGrowth.growth;
  teaches(
    "growth: no weekly history yet teaches what the panel measures",
    panelOf(noGrowth, "growth"),
    ["no weekly history yet", "Rescan over the coming weeks and it fills in from the first observation forward."]
  );

  const flat = clone(p2);
  flat.growth.weeks = flat.growth.weeks.map((w) => ({ weekStart: w.weekStart, firedItems: 0 }));
  teaches(
    "growth: an all-zero series is stated, never drawn as a measurement of zero",
    panelOf(flat, "growth"),
    ["every week reads zero", "An axis drawn over that would look like a measurement of zero rather than the absence of one."]
  );
}

// --- panels that DO have data still carry their method -----------------------
{
  const pq = panelBox(panelOf(p2, "prune"));
  check(
    "the quadrant plot states both exclusions rather than performing them silently",
    pq.includes("<b>1</b> not plotted — no dispatch record exists for them, which is not a zero") &&
      pq.includes("<b>1</b> not plotted — disabled, so no cost is being paid"),
    "exclusions not stated"
  );
  check(
    "both median lines are annotated with the value that placed them",
    pq.includes(">median 3 fires<") && pq.includes(">median 95 tok/session<"),
    "median annotation missing"
  );
  check(
    "the plot's dead-weight rule is stated as the same predicate the cost column uses",
    pq.includes("The same rule the cost column uses: enabled, at least a quarter of the priciest item&#39;s always-in-context cost, no fires recorded in the 41d window, and installed before that window opened."),
    "dead-weight predicate not stated"
  );
  const lb = panelBox(panelOf(p2, "budget"));
  check(
    "the budget bar states the modelled order and what a drop actually costs",
    lb.includes("<b>105%</b> of budget · <b>1</b> description dropped") &&
      lb.includes("needs <b>420</b> chars freed to fit") &&
      lb.includes("A dropped skill still exists and can still be typed; it just stops auto-triggering."),
    "budget panel wrong"
  );
  const mismatch = clone(p2);
  mismatch.header.listing.chars = 8999;
  check(
    "a header/model disagreement about the same listing shows BOTH figures",
    panelOf(mismatch, "budget").includes("header says 8,999 chars") &&
      panelOf(mismatch, "budget").includes("Both are shown rather than one quietly winning"),
    "a disagreement was resolved silently"
  );
}

// --- hostile payload: every new field, every new surface ---------------------
{
  // Three markers, each unmistakable in output: if any survives unescaped the
  // page is injectable from the files it audits. The ESCAPED form is asserted
  // too — a field that silently vanished would pass an absence-only test.
  const XS = "</section><script>alert(1)</script>";
  const XI = "<img src=x onerror=alert(1)>";
  const XB = `"><b>esc</b>`;

  const h = clone(p2);
  h.caveats = [XI, XB];
  h.growth.ownedSource = XS;
  h.superseded = [
    { plugin: XS, marketplace: XI, active: XB, versions: [XI, XB], bytes: 4096, paths: [XS, XI] },
  ];
  h.delta.pluginsUpdated = [
    { name: XS, to: XI },
    { name: XI, from: XB, to: XS },
  ];
  h.portfolio.topSpend = [
    { id: "id-blind", name: XS, chars: 900 },
    { id: "id-not-here", name: XI, chars: 400 },
  ];
  h.portfolio.flaggedByActivity = [
    { id: "id-blind", name: XB, fires: 3, lastFired: "2026-08-01T09:00:00Z", projects: 2 },
  ];
  h.budgetCut.order = h.budgetCut.order.map((o) => ({ ...o, name: XI }));
  h.providerWindows = {
    [XS]: { start: "2026-01-05T00:00:00Z", end: "2026-02-02T00:00:00Z", note: XB },
    [XI]: { start: "2026-03-02T00:00:00Z", end: "2026-04-06T00:00:00Z" },
  };

  const blind = h.items.find((i) => i.id === "id-blind");
  blind.name = XS;
  blind.description = XI;
  blind.path = XB;
  blind.readBy = [XS, XI];
  blind.refs = {
    checked: 2,
    missing: [{ path: XS, line: 3 }],
    notExecutable: [{ path: XI, line: 9 }],
  };
  blind.bundledFiles = [
    { relPath: XS, readInFires: 0, ofFires: 0 },
    { relPath: XI, readInFires: 1, ofFires: 2 },
  ];
  blind.confusable = [{ itemId: "id-scoped", name: XB, fires: 4 }];
  blind.nearMiss = [{ name: XS, count: 2 }];
  blind.crossProvider = [{ itemId: "id-scoped", source: XI, name: XS, identical: false }];
  blind.scopeNote = { allFiresIn: XS, alsoAtScope: XI };
  blind.collision = { paths: [XB] };
  blind.updateRelevance = { version: XI, identical: false, changedFiles: 2 };
  blind.plugin = {
    name: XS,
    marketplace: XI,
    version: XB,
    latest: XS,
    installedAt: "2026-03-24T00:00:00Z",
    lastUpdated: "2026-07-25T00:00:00Z",
  };
  blind.readOnlyReason = XI;
  blind.fires.byModel = [{ model: XS, count: 4 }];
  blind.fires.byProject = [{ name: XI, count: 4 }];
  blind.fires.events = [
    { id: "ev-h-1", ts: "2026-08-01T09:00:00Z", project: XB, channel: "typed", outcome: "error" },
  ];
  // The same providers on a second row, so the overlap matrix actually renders
  // with hostile column heads instead of falling through to an empty state.
  h.items.find((i) => i.id === "id-agents").readBy = [XS, XI];
  const off = h.items.find((i) => i.id === "id-off");
  off.disabledSafety.referencedBy = [XS, XI, XB];
  // The superseded row only joins to a group whose plugin name matches.
  h.superseded[0].plugin = XS;
  h.superseded[0].marketplace = XI;

  const surfaces = [
    R.renderApp(h, { ...R.defaultState(), selected: "id-blind" }),
    R.renderApp(h, { ...R.defaultState(), selected: "id-off" }),
    panelOf(h, "prune"),
    panelOf(h, "budget"),
    panelOf(h, "overlap"),
    panelOf(h, "growth"),
  ].join("\n");

  check(
    "no hostile string escapes into markup on any S2/S3 surface",
    !surfaces.includes("<script") &&
      !surfaces.includes("<img") &&
      !surfaces.includes("<b>esc</b>"),
    "unescaped interpolation"
  );
  {
    // An escaped payload still CONTAINS the text "onerror=…", so a substring
    // test proves nothing. Tags delimit cleanly (esc leaves no raw < or > in
    // any value), so: take every real tag, drop its quoted attribute values,
    // and look for an event handler in what is left.
    const tags = surfaces.match(/<[a-z][a-z0-9-]*\b[^<>]*>/gi) ?? [];
    const live = tags.filter((t) =>
      /\son(?:error|load|click|mouseover|focus)\s*=/i.test(t.replace(/"[^"]*"/g, '""'))
    );
    check(
      "no event handler attribute exists on any rendered tag",
      tags.length > 100 && live.length === 0,
      live.slice(0, 2).join(" | ")
    );
  }
  check(
    "the hostile values were rendered, escaped — not silently dropped",
    surfaces.includes("&lt;script&gt;alert(1)&lt;/script&gt;") &&
      surfaces.includes("&lt;img src=x onerror=alert(1)&gt;") &&
      surfaces.includes("&quot;&gt;&lt;b&gt;esc&lt;/b&gt;"),
    "hostile fields vanished instead of escaping"
  );
  check(
    "attribute contexts stay quoted — no marker breaks out of a title or data-tip",
    !/(?:title|data-tip)="[^"]*<(?:script|img|b)\b/.test(surfaces),
    "attribute break-out"
  );
  check(
    "the overlap matrix rendered with the hostile provider names as columns",
    panelOf(h, "overlap").includes(`class="ovl-prov"`) &&
      !panelOf(h, "overlap").includes("panel-void"),
    "hostile overlap fell through to an empty state"
  );
}

// --- the DOM-free contract --------------------------------------------------
{
  const src = readFileSync(modPath, "utf8");
  check(
    "the built renderer references no DOM API",
    !/\bdocument\s*\./.test(src) &&
      !/\blocalStorage\b/.test(src) &&
      !/\bwindow\s*\.\s*(?:location|document|addEventListener|setTimeout)\b/.test(src),
    "a DOM reference reached render.js"
  );
  check(
    "every assertion above ran in a process with no DOM at all",
    typeof globalThis.document === "undefined" && typeof globalThis.window === "undefined",
    "the test rig supplied a DOM"
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("all render assertions passed");
