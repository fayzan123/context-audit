// The four analysis panels — prune quadrant, listing budget, provider overlap,
// growth. Pure string rendering, exactly like render.ts and for the same
// reason: the frontend smoke test imports this module into Node with no
// browser rig, so a single `document.` reference here would break the build
// contract. Anything that touches the DOM lives in main.ts.
//
// Formatting helpers are IMPORTED from render.ts rather than copied. A second
// fmtInt is how two surfaces start formatting the same number differently, and
// this page's whole claim is that its numbers agree with each other.
import type { SourceId, UiItem, UiPayload } from "../../types.js";
import {
  type AppState,
  type Window,
  KIND_GLYPH,
  KIND_LABEL,
  esc,
  fmtInt,
  fmtK,
  isDeadWeight,
  navBase,
  navKey,
  signed,
  signedTokens,
  tokens,
  trackedSince,
  usageWindow,
  visibleItems,
  windowFor,
} from "./render.js";

/**
 * What the current nav entry holds, as a word. The sidebar decides the scope
 * now, so a panel caption says "skills" only when the sidebar does — it never
 * guesses from a mode flag that no longer exists.
 */
const scopeNoun = (payload: UiPayload, state: AppState): string =>
  KIND_LABEL[navKey(payload, state)] ?? "items";

// --- shared drawing helpers -----------------------------------------------
//
// Every SVG here is hand-written and viewBox-scaled. Colour never appears in
// the markup: marks paint with `currentColor` and an opacity, so the page's
// CSS custom properties stay the single source of truth for the palette and
// the stylesheet colours a panel by setting `color` on a handful of classes.
// Identity is carried by SHAPE — the KIND_GLYPH vocabulary the table already
// uses — never by hue.

/** SVG coordinate. Two decimals, and never NaN: one NaN kills a whole path. */
const n2 = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "0");

const fmtDay = (iso?: string): string => (iso ? iso.slice(0, 10) : "");

/** Whole days between two ISO stamps — the scan stamp is the only clock. */
function daysBetween(from: string, asOf?: string): number | undefined {
  if (!asOf) return undefined;
  const a = Date.parse(from);
  const b = Date.parse(asOf);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/** "2026-08-05" → "08-05"; the year rides on the first tick only. */
const fmtMd = (iso: string): string => iso.slice(5, 10);

/**
 * Axis ticks on round numbers. `intOnly` for axes whose unit cannot be
 * fractional — a "2.5 fires" gridline is a measurement that cannot exist.
 */
function ticksFor(max: number, target = 5, intOnly = false): number[] {
  if (!(max > 0)) return [0];
  const raw = max / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (intOnly) step = Math.max(1, Math.round(step));
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Where to DRAW a median split. The line goes in the empty space between the
 * two groups it separates, not on top of the data points that decide it —
 * otherwise a median of 0 fires lands underneath the pile of zero-fire items
 * it is supposed to be dividing. Returns the max value when nothing sits above
 * the median (every item tied), which is the geometry of an empty upper half.
 */
function splitAt(values: number[], med: number): number {
  let low = -Infinity;
  let high = Infinity;
  for (const v of values) {
    if (v <= med) low = Math.max(low, v);
    else high = Math.min(high, v);
  }
  if (!Number.isFinite(high)) return Number.isFinite(low) ? low : med;
  if (!Number.isFinite(low)) return high;
  return (low + high) / 2;
}

/** Engraved instrument label inside an SVG. Self-sufficient before CSS lands. */
function svgLabel(
  x: number,
  y: number,
  text: string,
  opts: { cls?: string; size?: number; anchor?: string; opacity?: number; rotate?: number } = {}
): string {
  const t = opts.rotate ? ` transform="rotate(${opts.rotate} ${n2(x)} ${n2(y)})"` : "";
  return `<text class="svg-engr${opts.cls ? ` ${opts.cls}` : ""}" x="${n2(x)}" y="${n2(y)}"${t} fill="currentColor" font-size="${opts.size ?? 11}" opacity="${opts.opacity ?? 0.62}" text-anchor="${opts.anchor ?? "start"}">${esc(text)}</text>`;
}

/** Tabular figure inside an SVG — numbers are the protagonist, so they align. */
function svgNum(
  x: number,
  y: number,
  text: string,
  opts: { cls?: string; size?: number; anchor?: string; opacity?: number } = {}
): string {
  return `<text class="svg-fig${opts.cls ? ` ${opts.cls}` : ""}" x="${n2(x)}" y="${n2(y)}" fill="currentColor" font-size="${opts.size ?? 10}" opacity="${opts.opacity ?? 0.75}" text-anchor="${opts.anchor ?? "start"}">${esc(text)}</text>`;
}

/** Native SVG tooltip. `data-tip` is a CSS ::after and pseudo-elements do not
 * render on SVG elements, so marks use <title> — the same native-title choice
 * the table's row cells already make. */
const svgTip = (s: string): string => `<title>${esc(s)}</title>`;

/**
 * The panel frame: engraved label, a caption that states the method, then the
 * body. No card, no border, no shadow — hairline rules and the engraved label
 * carry the structure, the way the rest of the page does.
 *
 * `capHtml` is markup the caller has already escaped; every value flowing in
 * from the payload goes through esc() at its own call site.
 */
function panel(key: string, title: string, capHtml: string, bodyHtml: string): string {
  return `<section class="panelbox panel-${esc(key)}" data-panel="${esc(key)}" aria-label="${esc(title)}">
    <div class="panel-head">
      <span class="engr">${esc(title)}</span>
      ${capHtml ? `<p class="panel-cap">${capHtml}</p>` : ""}
    </div>
    ${bodyHtml}
  </section>`;
}

/**
 * The empty state, which teaches: what this panel measures, why this machine
 * has nothing to show for it, and — where one exists — the control that would
 * change that. An empty axis is never drawn: a chart with no data is not a
 * measurement of zero, and rendering one as if it were is the exact failure
 * this page exists to avoid.
 */
function panelEmpty(
  key: string,
  title: string,
  headline: string,
  paras: string[],
  actionHtml = ""
): string {
  return `<section class="panelbox panel-${esc(key)} panel-void" data-panel="${esc(key)}" aria-label="${esc(title)}">
    <div class="panel-empty">
      <span class="engr">${esc(headline)}</span>
      ${paras.map((p) => `<p>${p}</p>`).join("")}
      ${actionHtml}
    </div>
  </section>`;
}

// Dead weight is decided by render.ts's exported `isDeadWeight` — IMPORTED,
// never re-implemented. A second copy here is how the plot's amber marks and
// the cost column's amber cells started gating on different windows while both
// comments claimed they could not disagree; there is one predicate now, and it
// judges each item against its own provider's window.

/**
 * The window(s) the dead-weight verdict is actually reached in, for the plotted
 * set. Only an item with a provenance date can be judged at all, so those are
 * the items whose windows this rule is evaluated over — naming any other span
 * would qualify the rule with a horizon it never used.
 */
function deadWeightWindows(items: UiItem[], win: Window): string {
  const judged = items
    .filter((i) => i.provenance !== undefined)
    .map((i) => ({ source: i.source, w: windowFor(win, i) }));
  if (judged.length === 0) return win.span ? `the ${win.span} window` : "the scanned window";
  // Keyed on both ends: the gate compares install dates against the START, so
  // two equal-length windows opening on different days are different gates.
  const distinct = [...new Set(judged.map((j) => `${j.w.start ?? "?"}|${j.w.span}`))];
  if (distinct.length === 1)
    return judged[0].w.span ? `the ${judged[0].w.span} window` : "the scanned window";
  const list = [...new Set(judged.map((j) => `${j.source} ${j.w.span || "undated"}`))].sort();
  return `its own provider's window (${list.join(" · ")})`;
}

/** Fires for an item in the SCANNED WINDOW. One method, one window — the
 * lifetime figure is a different measurement over a different span and the two
 * are never averaged onto one axis. `undefined` fires means "no dispatch
 * record exists", which is not a zero and is excluded upstream. */
const windowFires = (i: UiItem): number => (i.fires ? i.fires.invocations : 0);

// --- 1. prune quadrant -----------------------------------------------------

export type QuadrantKey = "costly-quiet" | "costly-busy" | "cheap-quiet" | "cheap-busy";

export interface PruneQuadrant {
  key: QuadrantKey;
  /** Reads off the actual split, so "no fires" is only ever said when the
   * median really is zero. */
  label: string;
  /** Item ids, so main.ts filters the table on exactly the plotted set rather
   * than re-deriving a median that might drift from this one. */
  ids: string[];
  count: number;
  /** Summed always-in-context chars. Chars are summed and converted ONCE, the
   * way the header does it — summing per-item rounded tokens would drift. */
  chars: number;
  /** How many of this quadrant's items the cost column also calls dead weight. */
  deadWeight: number;
}

export interface PruneModel {
  quads: Record<QuadrantKey, PruneQuadrant>;
  /** `win` on a member is THAT row's provider window, not the merged one. */
  items: { item: UiItem; tok: number; fires: number; quad: QuadrantKey; dead: boolean; win: Window }[];
  medianTok: number;
  medianFires: number;
  /** Plot coordinates of the split, placed BETWEEN the two groups. */
  tokSplit: number;
  firesSplit: number;
  maxTok: number;
  maxFires: number;
  /** Items withheld from the plot, each with the reason stated. */
  skippedUntracked: number;
  skippedDisabled: number;
  /** Everything the current scope could show, before the two exclusions. */
  scopeCount: number;
  win: Window;
  /** True when the plotted rows were counted over more than one window. */
  windowsDiffer: boolean;
  /** "claude 41d · codex 154d · cursor 83d" — the spans actually plotted. */
  windowList: string;
}

const QUAD_ORDER: QuadrantKey[] = ["costly-quiet", "costly-busy", "cheap-quiet", "cheap-busy"];

/**
 * The two portfolio facts that used to sit in a strip of their own above the
 * table: how few names do most of the work, and where the window spend goes.
 *
 * Both are cost-and-use questions, so they belong under the plot that asks
 * them — that is what "the portfolio strip is dissolved" means in practice.
 * They describe the WHOLE machine and do NOT follow the lens or the search, so
 * they say so in their own label rather than sitting silently beside figures
 * that do.
 */
function wholeMachine(payload: UiPayload): string {
  const p = payload.portfolio;
  const rent = payload.header.deadWeightChars;
  if (!p && !(rent !== undefined && rent > 0)) return "";
  const since = trackedSince(payload);
  const lines: string[] = [];
  // The silent-item rent: what is being paid, every session, for items that
  // predate their provider's window and recorded nothing inside it. It used to
  // hang off the header's never-fired readout as a sub-line; it is a cost fact
  // about silence, which is the exact subject of this plot.
  if (rent !== undefined && rent > 0) {
    lines.push(
      `<p class="wm-line" title="${esc(
        "Summed always-in-context cost of enabled items that predate their own provider's window start and recorded no fires inside it. A PER-SESSION figure — paid every session either way — and not the same unit as the window totals below it."
      )}"><b>${fmtK(tokens(rent))}</b> tok/session is paid on items with nothing recorded against them</p>`
    );
  }
  if (!p) return `<div class="wm"><span class="engr">across the whole machine</span>${lines.join("")}</div>`;
  const c = p.concentration;
  if (c && c.items > 0) {
    lines.push(
      `<p class="wm-line" title="${esc(
        `The fewest dispatch names whose fires add up to at least 80% of every fire on record${since ? `, counted since tracking began ${fmtDay(since)}` : ""}. Counted per dispatch name — provider + kind + name — because two rows sharing a name hold the same events, and summing rows would count those fires twice.`
      )}"><b>${fmtInt(c.items)}</b> name${c.items === 1 ? "" : "s"} account for <b>${fmtInt(c.pct)}%</b> of every recorded fire</p>`
    );
  }
  const spend = (p.topSpend ?? []).filter((s) => s.chars > 0).slice(0, 3);
  if (spend.length > 0) {
    const known = new Map(payload.items.map((i) => [i.id, i]));
    lines.push(
      `<p class="wm-line" title="${esc(
        "Always-in-context characters multiplied by the sessions the provider that loads them was observed in — a WINDOW TOTAL over the observed history, a different unit from the per-session cost on the axis above."
      )}">top window spend ${spend
        .map((s) => {
          const label = `${esc(s.name)} <b>${fmtK(tokens(s.chars))}<i>tok</i></b>`;
          return known.has(s.id)
            ? `<button class="wm-link" data-id="${esc(s.id)}">${label}</button>`
            : `<span class="wm-link">${label}</span>`;
        })
        .join(" ")}</p>`
    );
  }
  if (lines.length === 0) return "";
  return `<div class="wm"><span class="engr">across the whole machine</span>${lines.join("")}</div>`;
}

/**
 * The quadrant model, exported so main.ts can resolve a clicked quadrant to
 * its exact item ids. Computed over the items currently IN VIEW: the rail's
 * filters are on screen and their counts are faceted, so a plot that ignored
 * them would disagree with the readout right above it.
 */
export function pruneModel(payload: UiPayload, state: AppState): PruneModel {
  const win = usageWindow(payload);
  const inView = visibleItems(payload, state);
  const maxInjected = Math.max(...payload.items.map((i) => i.injectedChars), 0);

  // Two exclusions, both stated on the panel rather than performed silently:
  //   - fires === undefined: no dispatch record exists for this kind. Plotting
  //     it at x=0 would render an ABSENT measurement as a zero.
  //   - disabled: pays nothing right now, so it has no cost coordinate. The
  //     header total excludes it for the same reason.
  const tracked = inView.filter((i) => i.fires !== undefined);
  const plotted = tracked.filter((i) => i.enabled);

  const toks = plotted.map((i) => tokens(i.injectedChars));
  const fireCounts = plotted.map(windowFires);
  const medianTok = median(toks);
  const medianFires = median(fireCounts);

  const items = plotted.map((item) => {
    const tok = tokens(item.injectedChars);
    const fires = windowFires(item);
    const costly = tok > medianTok;
    const busy = fires > medianFires;
    const quad: QuadrantKey = costly
      ? busy
        ? "costly-busy"
        : "costly-quiet"
      : busy
        ? "cheap-busy"
        : "cheap-quiet";
    // Amber marks dead weight AND only ever inside the costly/quiet quadrant —
    // the one place the brief allows the signal colour on this plot.
    const dead = quad === "costly-quiet" && isDeadWeight(item, maxInjected, win);
    // The window THIS row's fire count was taken over. Marks from stores with
    // different retention share one axis, so each one carries its own span
    // rather than inheriting the caption's.
    return { item, tok, fires, quad, dead, win: windowFor(win, item) };
  });

  // Do the plotted rows share one window? A "41d" on the axis of a plot whose
  // marks were counted over 41, 154 and 83 days is a caption for one third of
  // the drawing, so the spans are named per provider when they differ.
  const spans = [...new Set(items.map((m) => m.win.span))];
  const windowsDiffer = spans.length > 1;
  const windowList = [...new Set(items.map((m) => `${m.item.source} ${m.win.span || "undated"}`))]
    .sort()
    .join(" · ");

  const quietLabel =
    medianFires === 0
      ? win.span && !windowsDiffer
        ? `no fires · ${win.span}`
        : "no fires"
      : `≤ ${fmtInt(medianFires)} fires`;
  const busyLabel = medianFires === 0 ? "any fires" : `> ${fmtInt(medianFires)} fires`;
  const labels: Record<QuadrantKey, string> = {
    "costly-quiet": `costly · ${quietLabel}`,
    "costly-busy": `costly · ${busyLabel}`,
    "cheap-quiet": `cheap · ${quietLabel}`,
    "cheap-busy": `cheap · ${busyLabel}`,
  };

  const quads = {} as Record<QuadrantKey, PruneQuadrant>;
  for (const key of QUAD_ORDER) {
    const members = items.filter((m) => m.quad === key);
    quads[key] = {
      key,
      label: labels[key],
      ids: members.map((m) => m.item.id),
      count: members.length,
      chars: members.reduce((a, m) => a + m.item.injectedChars, 0),
      deadWeight: members.filter((m) => m.dead).length,
    };
  }

  return {
    quads,
    items,
    medianTok,
    medianFires,
    tokSplit: splitAt(toks, medianTok),
    firesSplit: splitAt(fireCounts, medianFires),
    maxTok: Math.max(...toks, 0),
    maxFires: Math.max(...fireCounts, 0),
    skippedUntracked: inView.length - tracked.length,
    skippedDisabled: tracked.length - plotted.length,
    scopeCount: inView.length,
    win,
    windowsDiffer,
    windowList,
  };
}

/** Ids for one quadrant — the click contract, kept on this side of the wire. */
export function quadrantIds(payload: UiPayload, state: AppState, key: string): string[] {
  const m = pruneModel(payload, state);
  return (QUAD_ORDER as string[]).includes(key) ? m.quads[key as QuadrantKey].ids : [];
}

/** The 2×2 position glyph beside each readout: which cell of the plot this is. */
function quadGlyph(key: QuadrantKey): string {
  const col = key === "costly-quiet" || key === "cheap-quiet" ? 0 : 1;
  const rowTop = key === "costly-quiet" || key === "costly-busy" ? 0 : 1;
  const cells: string[] = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const active = r === rowTop && c === col;
      cells.push(
        `<rect x="${c * 6 + 0.5}" y="${r * 6 + 0.5}" width="5" height="5" fill="currentColor" fill-opacity="${active ? 1 : 0.26}"/>`
      );
    }
  }
  return `<svg class="qglyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">${cells.join("")}</svg>`;
}

/**
 * The prune view, which is the product: what should I turn off?
 *
 * It used to open on a cost × fires scatter and make the reader derive the
 * answer from it. On a real machine the median fire count is 0 — half the
 * marks stack on a single vertical line — so the quadrant split degenerates
 * and two paragraphs of method sit above a plot that says "most of these have
 * never fired". That sentence is the finding, and the payload already knew it.
 *
 * So the view now LEADS with the verdict in plain words, follows it with the
 * shortlist as a list you can act on, and keeps the distribution behind a
 * disclosure for anyone who wants to see the shape rather than the answer.
 */
export function renderPrune(payload: UiPayload, state: AppState): string {
  const m = pruneModel(payload, state);
  const win = m.win;
  const key = "prune";
  const title = "prune";
  const base = navBase(payload, state).length;
  const scopeWord = scopeNoun(payload, state);

  if (m.items.length === 0) {
    const why =
      m.scopeCount === 0
        ? [
            `Nothing is in view to plot. This scope holds <b>${fmtInt(base)}</b> ${esc(scopeWord)}; the filters on the rail are hiding all of them.`,
            `<button class="inlineclear" data-clear>clear filters</button>`,
          ]
        : [
            `Of the <b>${fmtInt(m.scopeCount)}</b> ${esc(scopeWord)} in view, <b>${fmtInt(m.skippedUntracked)}</b> leave no dispatch record in local transcripts and <b>${fmtInt(m.skippedDisabled)}</b> are disabled — so none of them has both coordinates this plot needs.`,
            `A cost × fires scatter needs a fire count that exists and a cost that is actually being paid. An item whose use cannot be counted either way is not a zero, and a disabled item is not a cost.`,
          ];
    return panelEmpty(key, title, "nothing to plot in this scope", why);
  }

  // --- geometry ---
  const W = 1160;
  const H = 468;
  const x0 = 92;
  const x1 = W - 18;
  const y0 = 30;
  const y1 = H - 54;
  const inset = 20; // room for the zero column, so it never sits on the axis
  const xMax = Math.max(m.maxFires, 1);
  const yMax = Math.max(m.maxTok, 1);
  const xs = (v: number): number => x0 + inset + (v / xMax) * (x1 - x0 - inset);
  const ys = (v: number): number => y1 - (v / yMax) * (y1 - y0);

  const xTicks = ticksFor(xMax, 6, true);
  const yTicks = ticksFor(yMax, 5, true);

  const grid =
    yTicks
      .map(
        (t) =>
          `<line class="grid" x1="${n2(x0)}" y1="${n2(ys(t))}" x2="${n2(x1)}" y2="${n2(ys(t))}" stroke="currentColor" stroke-width="1" opacity="${t === 0 ? 0.3 : 0.08}"/>`
      )
      .join("") +
    xTicks
      .map(
        (t) =>
          `<line class="grid" x1="${n2(xs(t))}" y1="${n2(y0)}" x2="${n2(xs(t))}" y2="${n2(y1)}" stroke="currentColor" stroke-width="1" opacity="0.06"/>`
      )
      .join("");

  const axes =
    `<line class="ax-line" x1="${n2(x0)}" y1="${n2(y0)}" x2="${n2(x0)}" y2="${n2(y1)}" stroke="currentColor" stroke-width="1" opacity="0.34"/>` +
    `<line class="ax-line" x1="${n2(x0)}" y1="${n2(y1)}" x2="${n2(x1)}" y2="${n2(y1)}" stroke="currentColor" stroke-width="1" opacity="0.34"/>` +
    xTicks
      .map(
        (t) =>
          `<line x1="${n2(xs(t))}" y1="${n2(y1)}" x2="${n2(xs(t))}" y2="${n2(y1 + 4)}" stroke="currentColor" stroke-width="1" opacity="0.34"/>` +
          svgNum(xs(t), y1 + 16, fmtInt(t), { anchor: "middle", opacity: 0.55, size: 9.5 })
      )
      .join("") +
    yTicks
      .map((t) => svgNum(x0 - 8, ys(t) + 3.5, fmtInt(t), { anchor: "end", opacity: 0.55, size: 9.5 }))
      .join("") +
    svgLabel(x0, y1 + 36, m.windowsDiffer ? "fires · each row's own provider window" : win.span ? `fires · ${win.span} window` : "fires · scanned history", {
      cls: "ax-title",
      size: 11,
      opacity: 0.7,
    }) +
    svgLabel(18, (y0 + y1) / 2, "tok / session", {
      cls: "ax-title",
      size: 11,
      opacity: 0.7,
      anchor: "middle",
      rotate: -90,
    });

  // --- median crosshair: each line annotated with the value that placed it ---
  const cx = xs(m.firesSplit);
  const cy = ys(m.tokSplit);
  const crosshair =
    `<line class="xhair" x1="${n2(cx)}" y1="${n2(y0)}" x2="${n2(cx)}" y2="${n2(y1)}" stroke="currentColor" stroke-width="1" stroke-dasharray="3 4" opacity="0.42"/>` +
    `<line class="xhair" x1="${n2(x0)}" y1="${n2(cy)}" x2="${n2(x1)}" y2="${n2(cy)}" stroke="currentColor" stroke-width="1" stroke-dasharray="3 4" opacity="0.42"/>` +
    svgLabel(
      cx + 5,
      y0 + 10,
      m.medianFires === 0
        ? `median 0 fires — half these items have none`
        : `median ${fmtInt(m.medianFires)} fires`,
      { cls: "xhair-lab", size: 11, opacity: 0.72 }
    ) +
    // Sat ON the line, which put it through any mark that happened to be at
    // the right-hand end of the median. Lifted clear; the stylesheet gives
    // .xhair-lab a surface halo for the cases that still graze a mark.
    svgLabel(x1 - 2, cy - 9, `median ${fmtInt(m.medianTok)} tok/session`, {
      cls: "xhair-lab",
      size: 11,
      opacity: 0.72,
      anchor: "end",
    });

  // --- clickable quadrant zones (mouse); the readouts beside the plot are the
  // keyboard path, so the zones stay out of the accessibility tree rather than
  // announcing every target twice. ---
  const zoneRect = (k: QuadrantKey): string => {
    const left = k === "costly-quiet" || k === "cheap-quiet";
    const top = k === "costly-quiet" || k === "costly-busy";
    const zx = left ? x0 : cx;
    const zw = left ? cx - x0 : x1 - cx;
    const zy = top ? y0 : cy;
    const zh = top ? cy - y0 : y1 - cy;
    if (zw <= 0 || zh <= 0) return "";
    return `<rect class="pq-zone" data-quadrant="${k}" x="${n2(zx)}" y="${n2(zy)}" width="${n2(zw)}" height="${n2(zh)}" fill="none" pointer-events="all">${svgTip(`${m.quads[k].label} — ${fmtInt(m.quads[k].count)} items, ${fmtInt(tokens(m.quads[k].chars))} tok/session. Click to filter the inventory to them.`)}</rect>`;
  };

  // --- marks: kind by shape, using the table's own glyph vocabulary. No
  // jitter — a nudged point is a wrong point, and the pile at (cheap, zero) is
  // the finding. Overlap reads through the surface ring the stylesheet paints
  // on .pq-mark. ---
  const marks = m.items
    .map(({ item, tok, fires, dead, win: iw }) => {
      const glyph = KIND_GLYPH[item.kind] ?? "◆";
      // The span quoted is THIS row's window — a cursor rule's count comes out
      // of a conversation store reaching back a year, and captioning it with
      // the transcript window would state a horizon it was never counted over.
      const firesText =
        fires > 0
          ? `${fmtInt(fires)} fire${fires === 1 ? "" : "s"}${iw.span ? ` in ${iw.span}` : ""}`
          : item.fires === null
            ? `no fires${iw.span ? ` in ${iw.span}` : ""}`
            : `0 fires${iw.span ? ` in ${iw.span}` : ""}${item.fires?.lifetime && item.fires.lifetime.invocations > 0 ? ` · ${fmtInt(item.fires.lifetime.invocations)} lifetime, outside this window` : ""}`;
      const tip =
        `${item.name} · ${item.kind}\n${fmtInt(tok)} tok/session · ${firesText}` +
        (m.windowsDiffer ? `\n${iw.span ? `${iw.span} window` : "window"}: ${item.source}'s own store` : "") +
        (dead
          ? `\n\nDead weight: paying a quarter or more of what your priciest item pays, with nothing recorded against it, and installed before this window opened.`
          : "");
      return `<text class="pq-mark${dead ? " dw" : ""}" data-id="${esc(item.id)}" x="${n2(xs(fires))}" y="${n2(ys(tok))}" fill="currentColor" font-size="11" text-anchor="middle" dominant-baseline="central">${svgTip(tip)}${esc(glyph)}</text>`;
    })
    .join("");

  const svg = `<svg class="chart pq-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="always-in-context cost by recorded fires, split at the medians">
    ${grid}${axes}${QUAD_ORDER.map(zoneRect).join("")}${crosshair}${marks}
  </svg>`;

  // --- the readout column: count and summed cost per quadrant, laid out to
  // mirror the plot. These are the real buttons — one target per quadrant,
  // named, keyboard-reachable, carrying the numbers exactly once. ---
  const readout = (k: QuadrantKey): string => {
    const q = m.quads[k];
    const dw =
      q.deadWeight > 0
        ? `<span class="pq-dw sig">${fmtInt(q.deadWeight)} dead weight</span>`
        : "";
    const tip =
      k === "costly-quiet"
        ? `Above the median cost, at or below the median fire count. This is the prune shortlist: click to filter the inventory to it.`
        : `${q.label}. Click to filter the inventory to these ${fmtInt(q.count)} items.`;
    return `<button class="pq-quad${k === "costly-quiet" ? " prime" : ""}" data-quadrant="${k}" ${q.count === 0 ? "disabled " : ""}data-tip="${esc(tip)}">
      ${quadGlyph(k)}
      <span class="pq-qlab">${esc(q.label)}</span>
      <span class="pq-qn">${fmtInt(q.count)}<i>${esc(scopeNoun(payload, state))}</i></span>
      <span class="pq-qtok">${fmtK(tokens(q.chars))}<i>tok/session</i></span>
      ${dw}
    </button>`;
  };

  const kindsPlotted = [...new Set(m.items.map((x) => x.item.kind))].sort();
  const legend = `<div class="pq-legend">
    <span class="engr">marks</span>
    <span class="pq-keys">${kindsPlotted
      .map(
        (k) =>
          `<span class="pq-key"><i class="kg kg-${esc(k)}" aria-hidden="true">${esc(KIND_GLYPH[k] ?? "◆")}</i>${esc(k)}</span>`
      )
      .join("")}</span>
    <span class="pq-key sig" data-tip="${esc(`The same rule the cost column uses: enabled, at least a quarter of the priciest item's always-in-context cost, no fires recorded in ${deadWeightWindows(m.items.map((x) => x.item), win)}, and installed before that window opened. Both surfaces read one exported predicate, so they cannot disagree — and the header's rent total sums the same age gate over every silent item, priciest quarter or not.`)}"><i class="kg" aria-hidden="true">◆</i>dead weight</span>
  </div>`;

  const excluded: string[] = [];
  if (m.skippedUntracked > 0)
    excluded.push(
      `<b>${fmtInt(m.skippedUntracked)}</b> not plotted — no dispatch record exists for them, which is not a zero`
    );
  if (m.skippedDisabled > 0)
    excluded.push(`<b>${fmtInt(m.skippedDisabled)}</b> not plotted — disabled, so no cost is being paid`);
  const filtered =
    m.scopeCount < base
      ? ` <button class="inlineclear" data-clear>clear filters</button> to plot all ${fmtInt(base)}.`
      : "";

  // --- the verdict, and then the list ---------------------------------------
  //
  // The shortlist IS the costly-and-quiet quadrant: above the median cost,
  // at or below the median fire count. It is the same set the plot marks, in
  // the same order the cost column sorts, as rows you can act on.
  const short = m.items
    .filter((x) => x.quad === "costly-quiet")
    .sort((x, y) => y.tok - x.tok || x.item.name.localeCompare(y.item.name));
  const shortTok = tokens(short.reduce((acc, x) => acc + x.item.injectedChars, 0));
  const totalTok = tokens(payload.header.injectedChars);
  const share = totalTok > 0 ? Math.round((shortTok / totalTok) * 100) : 0;
  const dead = short.filter((x) => x.dead).length;
  const silent = short.filter((x) => x.fires === 0).length;

  // What the reader came for, in one sentence at reading size. Every figure in
  // it is one the payload already computed; none of it is new arithmetic.
  const verdict =
    short.length === 0
      ? `Nothing is both expensive and unused. Every item above the median cost has fired at least ${fmtInt(m.medianFires + 1)} time${m.medianFires + 1 === 1 ? "" : "s"} in the window.`
      : `<b>${fmtInt(short.length)}</b> ${esc(scopeWord)} cost you <b>${fmtInt(shortTok)}</b> tok every session` +
        (silent === short.length
          ? ` and have never fired`
          : ` and are used less than half your inventory`) +
        (share > 0 ? ` — <b>${fmtInt(share)}%</b> of what your whole setup costs.` : ".");

  const rows = short
    .map((x) => {
      const it = x.item;
      const age = it.provenance ? daysBetween(it.provenance.installedAt, win.asOf) : undefined;
      const use =
        x.fires > 0
          ? `${fmtInt(x.fires)} fire${x.fires === 1 ? "" : "s"}`
          : `never used${age !== undefined && age > 0 ? ` · ${fmtInt(age)}d old` : ""}`;
      const on = (state.checked ?? []).includes(it.id);
      // Only a togglable row offers the checkbox: a plugin asset or a
      // project-scoped file cannot be turned off from here, and a control that
      // would refuse is worse than no control. The row still lists, with its
      // reason, because the cost is real either way.
      return `<li class="sl-row${x.dead ? " dw" : ""}${on ? " on" : ""}" data-id="${esc(it.id)}">
        ${
          it.togglable && it.enabled
            ? `<button class="sl-box" data-check="${esc(it.id)}" role="checkbox" aria-checked="${on}" aria-label="${esc(`select ${it.name} to turn off`)}"><i></i></button>`
            : `<span class="sl-box ro" title="${esc(it.readOnlyReason ?? "read-only")}">—</span>`
        }
        <span class="sl-name"><i class="kg kg-${esc(it.kind)}" aria-hidden="true">${esc(KIND_GLYPH[it.kind] ?? "")}</i>${esc(it.name)}</span>
        <span class="sl-tok">${fmtInt(x.tok)}<i>tok</i></span>
        <span class="sl-use">${esc(use)}</span>
      </li>`;
    })
    .join("");

  const checked = (state.checked ?? []).filter((id) => short.some((x) => x.item.id === id));
  const checkedTok = tokens(
    short.filter((x) => checked.includes(x.item.id)).reduce((acc, x) => acc + x.item.injectedChars, 0)
  );
  // The action states exactly what it will do and what it will save, and it
  // says where the files go — this moves directories, and a reader deserves to
  // know that before clicking rather than after.
  const action = `<div class="sl-act">
    <button class="btn sl-go" data-disable-checked${checked.length === 0 || state.busy ? " disabled" : ""}>${
      state.busy ? "turning off…" : `turn off ${fmtInt(checked.length)} selected`
    }</button>
    <span class="sl-save">${checked.length > 0 ? `saves <b>${fmtInt(checkedTok)}</b> tok every session` : "select rows to see what they cost you"}</span>
    <button class="sl-all" data-check-all>${checked.length === short.length && short.length > 0 ? "clear all" : "select all"}</button>
  </div>`;

  // How much of this list the action can actually reach. On a machine that is
  // mostly agents and plugin assets that is a MINORITY of the rows, and a
  // verdict counting 84 above a control that can move 24 would be the page
  // promising something it cannot do.
  const actionable = short.filter((x) => x.item.togglable && x.item.enabled).length;
  const reach =
    actionable === short.length
      ? ""
      : `<b>${fmtInt(actionable)}</b> of these can be turned off from here; the rest are agents, plugin assets or project-scoped files, which this tool measures but does not move — their cost is real either way. `;

  const note =
    reach +
    `Nothing is deleted: a disabled skill moves to <code>~/.claude/skills-disabled</code> and its fire history is kept, so turning one back on is the same click. ` +
    (dead > 0
      ? `<b>${fmtInt(dead)}</b> of these are <em>dead weight</em> — at least a quarter of your priciest item's cost, nothing recorded against them, and installed before the window opened.`
      : "");

  const excludedNote = excluded.length > 0 ? `<p class="kv-note">${excluded.join(" · ")}.${filtered}</p>` : "";

  // The distribution, for anyone who wants the shape rather than the answer.
  // Closed by default: it is evidence, and evidence goes under the finding.
  const plot = `<details class="pq-fold">
    <summary>show the cost × use distribution</summary>
    <p class="panel-cap">${
      `<b>${fmtInt(m.items.length)}</b> of ${fmtInt(base)} ${esc(scopeWord)} plotted on real units: always-in-context cost against fires recorded ${m.windowsDiffer ? "each in its own provider's window" : win.span ? `in the ${esc(win.span)} window` : "in the scanned history"}. ` +
      (m.windowsDiffer
        ? `Those are not one window (${esc(m.windowList)}): the stores keep different amounts of history, so a mark further right can mean a longer horizon rather than more use. `
        : "") +
      `The crosshair is the median of each axis, drawn between the two halves it splits; an item exactly at a median counts in the lower half.`
    }</p>
    <div class="pq-body">
      <div class="pq-plot">${svg}</div>
      <div class="pq-side">
        <div class="pq-grid">${QUAD_ORDER.map(readout).join("")}</div>
        ${legend}
      </div>
    </div>
  </details>`;

  const body = `<div class="sl">
    <p class="verdict">${verdict}</p>
    ${short.length > 0 ? `${action}<ol class="sl-list">${rows}</ol>` : ""}
    <p class="kv-note">${note}</p>
    ${excludedNote}
    ${wholeMachine(payload)}
    ${plot}
    <p class="kv-note cap-win">${esc(win.note)}</p>
  </div>`;

  return panel(key, title, "", body);
}

// --- 2. listing budget -----------------------------------------------------

export function renderListingBudget(payload: UiPayload, state: AppState): string {
  void state;
  const key = "budget";
  const title = "listing budget";
  const cut = payload.budgetCut;
  const listing = payload.header.listing;

  if (!cut || cut.order.length === 0) {
    // Two different absences, and they are not the same claim.
    if (listing) {
      return panelEmpty(key, title, "drop order not modelled", [
        `Your skill listing is <b>${fmtInt(listing.chars)}</b> of the ~<b>${fmtInt(listing.budgetChars)}</b>-char budget (<b>${fmtInt(listing.pct)}%</b>), but this scan carries no modelled drop order, so there is no per-skill cut to draw.`,
        // The consequence is the actionable half of this view and belongs on
        // it whether or not the order could be modelled: a reader arriving at
        // an over-budget figure needs to know what being over budget DOES.
        `Past the budget, Claude Code drops descriptions starting with the skills you invoke least. A dropped skill still exists and can still be typed; it just stops auto-triggering, which looks exactly like the model ignoring you.`,
        `The order replays that documented behaviour over your real listing. It needs fire counts to rank on; a scan with no readable history cannot produce it.`,
      ]);
    }
    return panelEmpty(key, title, "no skill listing on this machine", [
      `The listing budget is a Claude Code mechanic: every enabled skill's name and description shares a character budget (<code>skillListingBudgetFraction</code>, about 1% of the context window), and past it Claude Code drops descriptions starting with the skills you invoke least.`,
      `Nothing in this inventory is subject to it — no Claude-format skills were found — so there is no budget to be over or under. That is an absence of the mechanic, not a zero.`,
    ]);
  }

  const order = cut.order;
  const budget = cut.budgetChars;
  const listed = cut.listingChars;
  const dropped = order.filter((o) => o.dropped);
  const kept = order.filter((o) => !o.dropped);
  const over = listed > budget;
  // The header's percentage is the engine's own; using it verbatim is what
  // guarantees the two surfaces cannot disagree about the same budget.
  const pct = listing ? listing.pct : Math.round((listed / Math.max(1, budget)) * 100);
  const mismatch =
    listing && listing.chars !== listed
      ? `<span class="lb-mismatch dgr" data-tip="${esc(`The header counts ${listing.chars} listing characters; the modelled drop order counts ${listed}. Both are shown rather than one quietly winning — they are meant to be the same number.`)}">header says ${fmtInt(listing.chars)} chars</span>`
      : "";

  // --- geometry: the bar spans whatever is larger, the listing or the budget,
  // so the cut line is always ON the drawing rather than implied by an edge.
  const W = 1160;
  const H = 116;
  const x0 = 18;
  const x1 = W - 18;
  const barY = 44;
  const barH = 30;
  // Guarded: a listing and a budget that are both zero would divide the whole
  // drawing by nothing and put every coordinate at Infinity.
  const span = Math.max(1, Math.max(listed, budget) * 1.02);
  const sx = (v: number): number => x0 + (v / span) * (x1 - x0);

  const hatchId = "ca-hatch-budget";
  const defs = `<defs>
    <pattern id="${hatchId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="1.4" opacity="0.5"/>
    </pattern>
  </defs>`;

  // One segment per listed skill in keep order, 2 units of surface between
  // them. Hatching — not a second hue — carries "dropped".
  const segs = order
    .map((o) => {
      const left = sx(o.cumChars - o.chars);
      const w = Math.max(1, sx(o.cumChars) - left - 2);
      const need = o.cumChars - budget;
      const tip =
        `${o.name} — ${fmtInt(o.chars)} chars · ${fmtInt(o.fires)} fire${o.fires === 1 ? "" : "s"}\n` +
        `cumulative ${fmtInt(o.cumChars)} of ~${fmtInt(budget)}\n` +
        (o.dropped
          ? `dropped: its description falls outside the budget. ${fmtInt(need)} chars would have to go for it to fit.`
          : `fits: its description loads.`);
      return `<rect class="lb-seg${o.dropped ? " cut" : ""}" data-id="${esc(o.id)}" x="${n2(left)}" y="${barY}" width="${n2(w)}" height="${barH}" fill="${o.dropped ? `url(#${hatchId})` : "currentColor"}" fill-opacity="${o.dropped ? 1 : 0.34}" stroke="currentColor" stroke-opacity="${o.dropped ? 0.34 : 0}" stroke-width="1">${svgTip(tip)}</rect>`;
    })
    .join("");

  const cutX = sx(budget);
  // Under budget the cut sits at the far right of the drawing, so the label
  // has to fall back inside the frame rather than off the edge of it.
  const cutFlip = cutX > x1 - 160;
  const cutLine =
    `<line class="lb-cut" x1="${n2(cutX)}" y1="${barY - 14}" x2="${n2(cutX)}" y2="${barY + barH + 10}" stroke="currentColor" stroke-width="1" opacity="0.85"/>` +
    svgLabel(cutFlip ? cutX - 6 : cutX + 6, barY - 18, `budget ~${fmtInt(budget)} chars`, {
      cls: "lb-cutlab",
      size: 11,
      opacity: 0.8,
      anchor: cutFlip ? "end" : "start",
    }) +
    svgLabel(x0, barY - 18, `keep order · most-fired first`, { size: 11, opacity: 0.55 });

  // The end of the listing, marked where it actually falls relative to the cut.
  const endX = sx(listed);
  const endMark =
    `<line class="lb-end" x1="${n2(endX)}" y1="${barY + barH + 2}" x2="${n2(endX)}" y2="${barY + barH + 10}" stroke="currentColor" stroke-width="1" opacity="0.45"/>` +
    svgNum(endX, barY + barH + 22, `${fmtInt(listed)} chars listed`, {
      anchor: endX > (x0 + x1) / 2 ? "end" : "start",
      opacity: 0.6,
      size: 11,
    });

  const svg = `<svg class="chart lb-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(`skill listing: ${listed} characters against a ~${budget} character budget, ${dropped.length} descriptions dropped`)}">
    ${defs}${segs}${cutLine}${endMark}
  </svg>`;

  // The finding, in the words a reader thinks it in — "why did Claude stop
  // seeing my skill?" — with the LISTING BUDGET defined right here, at its
  // first appearance in this view, rather than in a glossary at the top of the
  // page. The percentage is still on screen; it just stops being the headline,
  // because a percentage is not a thing you can act on.
  const verdict = over
    ? `<b>${fmtInt(dropped.length)}</b> of your skills' description${dropped.length === 1 ? " is" : "s are"} not loading. ` +
      `Claude Code gives every enabled skill's name and description a shared budget of about <b>${fmtInt(budget)}</b> characters, and past it drops them starting with the ones you invoke least — so ${dropped.length === 1 ? "that skill has" : "those skills have"} quietly stopped auto-triggering. ` +
      `Free <b>${fmtInt(cut.headroomChars)}</b> characters and ${dropped.length === 1 ? "it comes" : "they all come"} back.`
    : `Every skill's description is loading. ` +
      `Claude Code gives them a shared budget of about <b>${fmtInt(budget)}</b> characters and drops the least-invoked past it; you are at <b>${fmtInt(pct)}%</b>, with <b>${fmtInt(Math.max(0, budget - listed))}</b> characters of slack before the first one goes.`;

  // Per-dropped item: the headroom IT needs — its own cumulative overflow, so
  // the list reads as "free this much and this row comes back".
  const CAP = 40;
  const shown = dropped.slice(0, CAP);
  const dropList =
    dropped.length > 0
      ? `<div class="lb-dropped">
          <span class="engr">dropped, least-fired first off the end</span>
          <ol class="lb-dlist">${shown
            .map((o) => {
              const need = Math.max(0, o.cumChars - budget);
              return `<li data-id="${esc(o.id)}">
                <span class="lb-dname">${esc(o.name)}</span>
                <span class="lb-dfig">${fmtInt(o.chars)}<i>chars</i></span>
                <span class="lb-dfig">${fmtInt(o.fires)}<i>fire${o.fires === 1 ? "" : "s"}</i></span>
                <span class="lb-dneed">needs <b>${fmtInt(need)}</b> chars freed to fit</span>
              </li>`;
            })
            .join("")}</ol>
          ${dropped.length > CAP ? `<p class="kv-note">${fmtInt(dropped.length - CAP)} further dropped rows not listed here — they are in the inventory table below the cut divider.</p>` : ""}
        </div>`
      : `<div class="lb-dropped">
          <span class="engr">nothing dropped</span>
          <p class="kv-note">Every listed description fits inside the budget, so every skill can still auto-trigger.${kept.length > 0 ? ` The last one to fit is <b>${esc(kept[kept.length - 1].name)}</b>, at ${fmtInt(kept[kept.length - 1].cumChars)} of ~${fmtInt(budget)} chars.` : ""}</p>
        </div>`;

  const body = `<div class="lb-body">
    <p class="verdict">${verdict}</p>
    <p class="kv-note">A dropped skill still exists and can still be typed — it just stops auto-triggering, which looks exactly like the model ignoring you.${mismatch ? ` ${mismatch}` : ""}</p>
    ${dropList}
    <details class="pq-fold">
      <summary>show the listing against its budget</summary>
      <p class="panel-cap">One segment per listed skill in the order Claude Code keeps them — most-fired first — hatched past the cut. This replays the documented drop order over your real listing.</p>
      ${svg}
    </details>
  </div>`;

  return panel(key, title, "", body);
}

// --- 3. provider overlap ---------------------------------------------------

export interface ProviderWindow {
  /** ISO start of this provider's readable history. */
  start?: string;
  end?: string;
  /** Anything qualifying this provider's store — an undocumented schema, say. */
  note?: string;
}
export type ProviderWindows = Partial<Record<SourceId, ProviderWindow>>;

/**
 * A harness that reads and dispatches files, as opposed to a file class. The
 * `agents-md` source is the cross-tool standard itself — audited once, not
 * once per tool that reads it — so it names a row, never a column: a column
 * headed "agents-md" would claim a harness that does not exist.
 */
const isHarness = (s: SourceId): boolean => s === "claude" || s === "codex" || s === "cursor";

/**
 * Which providers touch this asset at all — readers, firers, and the harnesses
 * holding a copy of it.
 *
 * That last clause is what makes this panel reachable. Readers and firers alone
 * can only ever name ONE provider on a real machine: `byProvider` is built from
 * a join key that already pins a provider, and `readBy` is populated solely by
 * Codex rollouts naming an AGENTS.md they loaded. So the matrix stood empty
 * while asserting "nothing is being paid for twice" on machines that hold the
 * same skill under two harnesses — which is the overlap people actually have,
 * and which IS paid for twice, once under each.
 */
function providersOf(item: UiItem): SourceId[] {
  const set = new Set<SourceId>(item.readBy ?? []);
  if (item.fires?.byProvider) {
    for (const [p, n] of Object.entries(item.fires.byProvider)) {
      if (typeof n === "number" && n > 0) set.add(p as SourceId);
    }
  }
  if (item.crossProvider && item.crossProvider.length > 0) {
    if (isHarness(item.source)) set.add(item.source);
    for (const c of item.crossProvider) if (isHarness(c.source)) set.add(c.source);
  }
  return [...set].sort();
}

// Both halves of a cross-provider pair get their own row on purpose. Collapsing
// them to one would be wrong twice over: they are two SEPARATE files, each
// loaded and paid for by its own harness — which is the fact this panel exists
// to show — and a shared dispatch name is not proof of a shared file. A global
// `~/.codex/AGENTS.md` and a project `AGENTS.md` are twins by name while
// carrying different readers, and merging them would drop one set of evidence.

export function renderProviderOverlap(
  payload: UiPayload,
  state: AppState,
  windows?: ProviderWindows
): string {
  const key = "overlap";
  const title = "provider overlap";
  const win = usageWindow(payload);

  // Payload-wide by construction: this view is a sidebar destination now, and
  // the sidebar's entry IS the whole inventory. The two empty states that used
  // to cover a narrowed scope — "shared assets sit outside this scope", "one
  // provider on this machine" — are gone with it: the first can no longer
  // happen, and the second never reaches the page at all, because an entry
  // appears only when it has something to show and a single-provider machine
  // has nothing to cross.
  const shared = (items: UiItem[]): UiItem[] => items.filter((i) => providersOf(i).length > 1);
  const inScope = shared(navBase(payload, state));

  if (inScope.length === 0) {
    const providerCount = new Set(payload.items.map((i) => i.source)).size;
    return panelEmpty(key, title, "nothing is shared", [
      `<b>${fmtInt(providerCount)}</b> providers were found, but no asset is read or fired by more than one of them, and no dispatch name exists under two harnesses. Each harness is reading only its own files.`,
      // Deliberately NOT "nothing is paid for twice". Only two kinds of sharing
      // leave evidence anywhere on a machine — a Codex rollout naming an
      // AGENTS.md it loaded, and the same dispatch name installed under two
      // harnesses — so an empty matrix means neither of those was found, which
      // is a narrower claim than "nothing overlaps".
      `Two things leave a record here: a rollout naming an instruction file it loaded, and one dispatch name installed under two harnesses. Neither was found — which is what this panel can see, not a guarantee that no file is duplicated.`,
    ]);
  }

  const cols = [...new Set(inScope.flatMap(providersOf))].sort();
  // Rows sorted by how much they overlap, then by lifetime fires — the most
  // entangled asset is the one worth looking at first.
  const rows = [...inScope].sort((a, b) => {
    const d = providersOf(b).length - providersOf(a).length;
    if (d !== 0) return d;
    const fa = a.fires?.lifetime?.invocations ?? a.fires?.invocations ?? 0;
    const fb = b.fires?.lifetime?.invocations ?? b.fires?.invocations ?? 0;
    return fb - fa || a.name.localeCompare(b.name);
  });

  // Per-provider windows, when the caller has them. This payload carries ONE
  // merged transcript window and one ledger tracking date, so without them the
  // column heads say which shared window they mean instead of inventing four.
  const trackedSince = rows
    .map((r) => r.fires?.trackedSince)
    .filter((t): t is string => typeof t === "string")
    .sort()[0];
  const sharedWindow = trackedSince
    ? `since ${fmtDay(trackedSince)}`
    : payload.history?.windowStart
      ? `${fmtDay(payload.history.windowStart)} → ${fmtDay(payload.history.windowEnd)}`
      : "window unknown";
  let anyPerProvider = false;

  const head = cols
    .map((p) => {
      const w = windows?.[p];
      const dated = !!(w && (w.start || w.end));
      if (dated) anyPerProvider = true;
      const range = dated
        ? `${fmtDay(w!.start) || "?"} → ${fmtDay(w!.end) || "?"}`
        : sharedWindow;
      const tip = dated
        ? `${p}: this provider's own readable history covers ${range}. Each store keeps a different amount, so a bigger number in one column can just mean a longer window.${w!.note ? `\n\n${w!.note}` : ""}`
        : `This payload carries one shared history window, not a per-provider one: ${range}. Counts in different columns come from stores with different retention, so they are not like-for-like.`;
      return `<th scope="col" class="ovl-col" data-tip="${esc(tip)}">
        <span class="ovl-prov">${esc(p)}</span>
        <span class="ovl-win${dated ? "" : " shared"}">${esc(range)}</span>
      </th>`;
    })
    .join("");

  const cell = (item: UiItem, p: SourceId): string => {
    const reads = (item.readBy ?? []).includes(p);
    const fires = item.fires?.byProvider?.[p];
    if (typeof fires === "number" && fires > 0) {
      return `<td class="ovl-cell fired" title="${esc(`${fmtInt(fires)} recorded fire${fires === 1 ? "" : "s"} under ${p}${trackedSince ? `, since tracking began ${fmtDay(trackedSince)}` : ""}. Per-provider last-fired is not carried in this payload, so the row's last-fired column covers every provider together.`)}"><b>${fmtInt(fires)}</b></td>`;
    }
    if (reads) {
      return `<td class="ovl-cell read" title="${esc(`${p} loads this file. No fires are recorded against it under ${p}${trackedSince ? ` since tracking began ${fmtDay(trackedSince)}` : ""} — an instruction file is read, not dispatched, so that is expected rather than a silence worth acting on.`)}">read</td>`;
    }
    // A separate COPY under this harness: its fires live on its own row in the
    // payload, so they are read from there rather than reported as this copy's.
    // Rendering "·" here would say no record exists when a whole second copy
    // does — the fact the panel is for.
    const twinHere = (item.crossProvider ?? []).find((c) => c.source === p);
    if (twinHere) {
      const twinItem = payload.items.find((i) => i.id === twinHere.itemId);
      const tf = twinItem?.fires?.lifetime?.invocations ?? twinItem?.fires?.invocations;
      const same = twinHere.identical ? "byte-identical body" : "different body";
      const tip =
        `A separate copy of "${twinHere.name}" is installed under ${p} (${same}). ` +
        (typeof tf === "number"
          ? `That copy has ${fmtInt(tf)} recorded fire${tf === 1 ? "" : "s"} of its own.`
          : `No fire history is recorded for that copy.`) +
        ` Each harness loads and pays for its own copy.`;
      return `<td class="ovl-cell copy" title="${esc(tip)}">${
        typeof tf === "number" ? `<b>${fmtInt(tf)}</b><i>copy</i>` : `copy`
      }</td>`;
    }
    // Absent, and it must never render as 0: nothing on this machine says this
    // provider ever looked at this file.
    return `<td class="ovl-cell void" title="${esc(`No record that ${p} reads or fires this asset. An empty cell is an absent observation, not a zero.`)}"><span aria-hidden="true">·</span><span class="sr">no record</span></td>`;
  };

  const body = rows
    .map((item) => {
      const f = item.fires;
      const last = f?.lifetime?.lastFired ?? f?.lastFired;
      const twin =
        item.crossProvider && item.crossProvider.length > 0
          ? `<span class="ovl-twin" title="${esc(
              item.crossProvider
                .map(
                  (c) =>
                    `${c.name} also exists under ${c.source} — ${c.identical ? "byte-identical body" : "different body"}`
                )
                .join("\n")
            )}">twin</span>`
          : "";
      return `<tr data-id="${esc(item.id)}">
        <th scope="row" class="ovl-name" title="${esc(item.description ? `${item.description}\n\n${item.path}` : item.path)}">
          <i class="kg kg-${esc(item.kind)}" aria-hidden="true">${esc(KIND_GLYPH[item.kind] ?? "")}</i>${esc(item.name)}${twin}
        </th>
        ${cols.map((p) => cell(item, p)).join("")}
        <td class="ovl-last">${last ? esc(fmtDay(last)) : `<span class="na">${esc(win.none)}</span>`}</td>
      </tr>`;
    })
    .join("");

  const cap =
    `<b>${fmtInt(rows.length)}</b> asset${rows.length === 1 ? " is" : "s are"} read or fired by more than one of your tools, and each harness loads and pays for its own copy. ` +
    `A cell carries that provider's recorded fires; <b>read</b> means the provider loads the file but dispatches nothing from it; an empty cell means no record that the provider touches it at all — an absent observation, never a zero. ` +
    (anyPerProvider
      ? `Each column states its own provider's window, because the stores keep different amounts of history and the counts are not like-for-like.`
      : `Every column shares one window (${esc(sharedWindow)}): this payload carries no per-provider retention dates, so the columns are not like-for-like and are not labelled as if they were.`) +
    `<span class="cap-win">${esc(win.note)}</span>`;

  const table = `<div class="ovl-wrap"><table class="ovl" aria-label="provider overlap matrix">
    <thead><tr><th scope="col" class="ovl-corner"><span class="engr">asset</span></th>${head}<th scope="col" class="ovl-col"><span class="ovl-prov">last fired</span><span class="ovl-win shared">all providers</span></th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;

  return panel(key, title, cap, table);
}

// --- 4. growth -------------------------------------------------------------

export function renderGrowth(payload: UiPayload, state: AppState): string {
  void state;
  const key = "growth";
  const title = "owned vs used";
  const g = payload.growth;

  if (!g || g.weeks.length === 0) {
    return panelEmpty(
      key,
      title,
      "no weekly history yet",
      [
        `This panel plots two counts of the same thing — instruction files you own, and instruction files that actually fired — over ISO weeks, so the gap between them is visible.`,
        `Owned counts come from scan snapshots and fired counts from the durable ledger. Neither has recorded a week yet on this machine, so there is no series to draw. Rescan over the coming weeks and it fills in from the first observation forward.`,
      ],
      sinceLastScan(payload)
    );
  }

  const weeks = [...g.weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const observed = weeks.filter((w) => typeof w.owned === "number");
  const maxV = Math.max(
    ...weeks.map((w) => Math.max(w.firedItems, typeof w.owned === "number" ? w.owned : 0)),
    0
  );

  if (maxV === 0) {
    return panelEmpty(
      key,
      title,
      "every week reads zero",
      [
        `<b>${fmtInt(weeks.length)}</b> week${weeks.length === 1 ? " is" : "s are"} on record, and none of them carries an owned count or a single firing item.`,
        `An axis drawn over that would look like a measurement of zero rather than the absence of one. ${esc(g.ownedSource)}`,
      ],
      sinceLastScan(payload)
    );
  }

  // --- geometry: ONE axis. Both series count items, so a second y-scale would
  // be inventing a relationship between them.
  const W = 1160;
  const H = 210;
  const x0 = 66;
  const x1 = W - 24;
  const y0 = 26;
  const y1 = H - 60;
  const band = (x1 - x0) / weeks.length;
  const bx = (i: number): number => x0 + i * band;
  const yMax = Math.max(maxV, 1);
  const ys = (v: number): number => y1 - (v / yMax) * (y1 - y0);
  const yTicks = ticksFor(yMax, 4, true);

  const grid = yTicks
    .map(
      (t) =>
        `<line class="grid" x1="${n2(x0)}" y1="${n2(ys(t))}" x2="${n2(x1)}" y2="${n2(ys(t))}" stroke="currentColor" stroke-width="1" opacity="${t === 0 ? 0.3 : 0.08}"/>` +
        svgNum(x0 - 8, ys(t) + 3.5, fmtInt(t), { anchor: "end", opacity: 0.55, size: 9.5 })
    )
    .join("");

  const stride = Math.max(1, Math.ceil(weeks.length / 10));
  const xAxis =
    `<line class="ax-line" x1="${n2(x0)}" y1="${n2(y1)}" x2="${n2(x1)}" y2="${n2(y1)}" stroke="currentColor" stroke-width="1" opacity="0.34"/>` +
    weeks
      .map((w, i) =>
        i % stride === 0
          ? `<line x1="${n2(bx(i) + band / 2)}" y1="${n2(y1)}" x2="${n2(bx(i) + band / 2)}" y2="${n2(y1 + 4)}" stroke="currentColor" stroke-width="1" opacity="0.34"/>` +
            svgNum(bx(i) + band / 2, y1 + 16, i === 0 ? fmtDay(w.weekStart) : fmtMd(w.weekStart), {
              anchor: "middle",
              opacity: 0.55,
              size: 11,
            })
          : ""
      )
      .join("") +
    svgLabel(x0, y1 + 34, "ISO week", { cls: "ax-title", size: 11, opacity: 0.62 }) +
    svgLabel(18, (y0 + y1) / 2, "items", {
      cls: "ax-title",
      size: 11,
      opacity: 0.62,
      anchor: "middle",
      rotate: -90,
    });

  // Bars: distinct items that fired that week. Square ends, 2 units of surface
  // between neighbours — an instrument's marks, not a rounded chart widget.
  const barW = Math.max(2, Math.min(band - 3, 26));
  const bars = weeks
    .map((w, i) => {
      const cx = bx(i) + band / 2;
      const h = y1 - ys(w.firedItems);
      const rect =
        w.firedItems > 0
          ? `<rect class="gw-bar" x="${n2(cx - barW / 2)}" y="${n2(ys(w.firedItems))}" width="${n2(barW)}" height="${n2(h)}" fill="currentColor" fill-opacity="0.26"/>`
          : "";
      // A hover target over the whole band, so the weeks with nothing in them
      // can still say what they are.
      const owned =
        typeof w.owned === "number"
          ? `${fmtInt(w.owned)} owned`
          : "no owned observation this week";
      return `${rect}<rect class="gw-hit" x="${n2(bx(i))}" y="${n2(y0)}" width="${n2(band)}" height="${n2(y1 - y0)}" fill="none" pointer-events="all">${svgTip(`week of ${fmtDay(w.weekStart)}\n${fmtInt(w.firedItems)} item${w.firedItems === 1 ? "" : "s"} fired\n${owned}`)}</rect>`;
    })
    .join("");

  // Step line: owned only changes at a scan event, so it holds flat across its
  // week and steps at the boundary. Weeks with no observation are GAPS — the
  // path breaks and starts again. Interpolating across them would draw a
  // history the snapshots never recorded, which is the one thing this chart
  // must not do.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  weeks.forEach((w, i) => {
    if (typeof w.owned === "number") {
      run.push({ i, v: w.owned });
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length > 0) runs.push(run);

  const paths = runs
    .map((r) => {
      let d = `M ${n2(bx(r[0].i))} ${n2(ys(r[0].v))} H ${n2(bx(r[0].i) + band)}`;
      for (let k = 1; k < r.length; k++) {
        // A break inside a run cannot happen (runs are contiguous), so every
        // step here is a real week-to-week observation.
        d += ` V ${n2(ys(r[k].v))} H ${n2(bx(r[k].i) + band)}`;
      }
      return `<path class="gw-step" d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.9"/>`;
    })
    .join("");

  const dots = observed
    .map((w) => {
      const i = weeks.indexOf(w);
      return `<circle class="gw-obs" cx="${n2(bx(i) + band / 2)}" cy="${n2(ys(w.owned as number))}" r="2.6" fill="currentColor" opacity="0.9">${svgTip(`week of ${fmtDay(w.weekStart)} — ${fmtInt(w.owned as number)} owned (snapshot observation)`)}</circle>`;
    })
    .join("");

  // Weeks with no owned observation get an explicit tick on the axis: a gap
  // that is MARKED reads as missing data; a gap that is merely blank reads as
  // a chart that forgot.
  const gapTicks = weeks
    .map((w, i) =>
      typeof w.owned === "number"
        ? ""
        : `<line class="gw-gap" x1="${n2(bx(i) + band / 2)}" y1="${n2(y1 - 3)}" x2="${n2(bx(i) + band / 2)}" y2="${n2(y1 + 3)}" stroke="currentColor" stroke-width="1" opacity="0.28"/>`
    )
    .join("");

  // Direct labels on the last value of each series — two series, so a legend
  // is present too, and identity is carried by mark shape rather than colour.
  const lastObs = observed[observed.length - 1];
  const lastFiredWeek = [...weeks].reverse().find((w) => w.firedItems > 0);
  const directs =
    (lastObs
      ? (() => {
          // Above the line's last step, not on it: at the right-hand edge the
          // label and the line it names occupy the same pixels otherwise.
          const i = weeks.indexOf(lastObs);
          const right = bx(i) + band > x1 - 90;
          return svgNum(
            right ? x1 - 2 : bx(i) + band + 6,
            ys(lastObs.owned as number) - 8,
            `owned ${fmtInt(lastObs.owned as number)}`,
            { cls: "gw-dl", opacity: 0.85, size: 10, anchor: right ? "end" : "start" }
          );
        })()
      : "") +
    (lastFiredWeek
      ? svgNum(
          bx(weeks.indexOf(lastFiredWeek)) + band / 2,
          ys(lastFiredWeek.firedItems) - 6,
          `fired ${fmtInt(lastFiredWeek.firedItems)}`,
          { cls: "gw-dl", opacity: 0.75, size: 10, anchor: "middle" }
        )
      : "");

  const svg = `<svg class="chart gw-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(`instruction files owned and instruction files that fired, per ISO week, on one shared axis of item counts`)}">
    ${grid}${xAxis}${bars}${gapTicks}${paths}${dots}${directs}
  </svg>`;

  const gaps = weeks.length - observed.length;
  const legend = `<div class="gw-legend">
    <span class="gw-key"><svg class="gw-swatch" viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><path d="M0 9 H7 V4 H15 V2 H22" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>owned<i>${esc(g.ownedSource)}</i></span>
    <span class="gw-key"><svg class="gw-swatch" viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><rect x="3" y="3" width="6" height="9" fill="currentColor" fill-opacity="0.26"/><rect x="13" y="6" width="6" height="6" fill="currentColor" fill-opacity="0.26"/></svg>fired<i>distinct items with at least one recorded fire that week — durable ledger events</i></span>
  </div>`;

  // The finding first: two counts of the same thing, and the gap between them
  // is the whole point. A typical week is the MEDIAN of the observed weeks —
  // a mean would be dragged by one busy fortnight.
  const firedWeeks = weeks.map((w) => w.firedItems);
  const typical = Math.round(median(firedWeeks));
  const ownedNow = lastObs ? (lastObs.owned as number) : undefined;
  const verdict =
    ownedNow !== undefined
      ? `You own <b>${fmtInt(ownedNow)}</b> instruction files. In a typical week <b>${fmtInt(typical)}</b> of them get used.`
      : `In a typical week <b>${fmtInt(typical)}</b> of your instruction files get used. No scan snapshot has recorded how many you own, so the owned line has nothing to draw yet.`;

  const cap =
    `Both series count items, so they share one axis — a second scale would invent a relationship between them. ` +
    (observed.length === 0
      ? `No week carries an owned observation, so only the bars are drawn. `
      : gaps > 0
        ? `The owned line breaks over the <b>${fmtInt(gaps)}</b> week${gaps === 1 ? "" : "s"} with no snapshot — ticked on the axis, and never interpolated across: joining them would draw a history the snapshots never recorded. `
        : `Every week on record carries an owned observation, so the line runs unbroken. `) +
    `Each series is captioned with the method it came from.`;

  return panel(
    key,
    title,
    "",
    `<div class="gw-body">
      <p class="verdict">${verdict}</p>
      ${svg}${legend}
      <p class="kv-note">${cap}</p>
      ${sinceLastScan(payload)}
    </div>`
  );
}

/**
 * What changed since the previous scan. It used to ride the portfolio strip
 * above the table, where it competed with the figures that describe NOW; it is
 * a change-over-time fact, so it belongs under the chart that plots change
 * over time.
 */
function sinceLastScan(payload: UiPayload): string {
  const d = payload.delta;
  if (!d) return "";
  const ups = d.pluginsUpdated ?? [];
  // No `from` on disk means the previous version was never recorded. Said in
  // those words: a sentinel in that slot would read as a version number.
  const upText = (u: { name: string; from?: string; to: string }): string =>
    u.from ? `${u.name} ${u.from} → ${u.to}` : `${u.name} updated to ${u.to} (previous version not recorded)`;
  const tok = signedTokens(d.injectedChars);
  const quiet = d.items === 0 && d.injectedChars === 0 && ups.length === 0;
  return `<div class="wm gw-delta">
    <span class="engr">since the previous scan · ${esc(fmtDay(d.since))}</span>
    <p class="wm-line">${
      quiet
        ? `no change — same items, same always-in-context cost, no plugin moved`
        : `<b>${esc(signed(d.items))}</b> item${Math.abs(d.items) === 1 ? "" : "s"} · <b>${esc(signed(tok))}</b> tok/session`
    }</p>
    ${
      ups.length > 0
        ? `<p class="wm-line">${ups.map((u) => esc(upText(u))).join(" · ")}</p>
           <p class="kv-note">Plugin moves come from each plugin manifest's "current version since" date, not from the snapshot — snapshots record no plugin versions, which is why a previous version can be unrecorded.</p>`
        : `<p class="kv-note">Item and cost diffs are the previous snapshot's own figures subtracted from this one. Snapshots record no plugin versions, so a plugin move is read from the manifest's "current version since" date; none moved between these two scans.</p>`
    }
  </div>`;
}

// --- panel registry --------------------------------------------------------

/**
 * The analysis views, keyed the way the sidebar navigates to them. The keys
 * are the payload's own vocabulary (`budget`, `overlap`); the sidebar's labels
 * — `listing`, `providers` — live with the sidebar, so a renaming in the
 * chrome never has to reach the panel registry or the payload.
 */
export const PANELS: { key: string; label: string }[] = [
  { key: "prune", label: "prune" },
  { key: "budget", label: "listing" },
  { key: "overlap", label: "providers" },
  { key: "growth", label: "growth" },
];

/** Dispatch. Anything that is not an analysis key renders nothing here. */
export function renderPanel(
  key: string,
  payload: UiPayload,
  state: AppState,
  windows?: ProviderWindows
): string {
  switch (key) {
    case "prune":
      return renderPrune(payload, state);
    case "budget":
      return renderListingBudget(payload, state);
    case "overlap":
      return renderProviderOverlap(payload, state, windows);
    case "growth":
      return renderGrowth(payload, state);
    default:
      return "";
  }
}
