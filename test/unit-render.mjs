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
const drawerFor = (name, state = R.defaultState()) =>
  R.renderDrawerBody(byName(name), state, win);

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
  const fireless = new Set(["typedonly", "cold", "edited", "plainzero", "style-rule"]);
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

// --- escaping ----------------------------------------------------------------
{
  const hostile = {
    ...byName("hot"),
    id: "id-hostile",
    provenance: { installedAt: "2026-03-22T00:00:00Z", source: "plugin-manifest", origin: "<b>evil</b>" },
    collision: { paths: ['</ul><script>alert(1)</script>'] },
    fires: {
      ...byName("hot").fires,
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

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("all render assertions passed");
