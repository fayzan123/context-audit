// Pure string rendering — no DOM APIs anywhere in this file. That is a load-
// bearing constraint, not a style choice: the frontend smoke test imports this
// module into Node and renders fixture payloads without a browser rig.
import type {
  Provenance,
  ProvenanceSource,
  SecurityFinding,
  SourceId,
  UiFires,
  UiItem,
  UiPayload,
  UiSuperseded,
} from "../../types.js";
// The analysis panels. views.ts imports its formatting helpers back out of
// this module, which makes the pair a cycle — safe because neither side
// touches the other at module-evaluation time: every cross-module reference
// lives inside a function body.
import { renderPanel } from "./views.js";

export type SortKey = "name" | "source" | "scope" | "injected" | "activity" | "findings" | "state";

/**
 * One line of the on-page activity log — the same lines the server prints to
 * its terminal, plus the CLI output of plugin updates. `at` is a preformatted
 * HH:MM:SS stamp (main.ts owns the clock; rendering stays pure).
 */
export interface LogEntry {
  at: string;
  kind: "cmd" | "out" | "ok" | "err" | "info";
  text: string;
}

export interface AppState {
  /**
   * The sidebar selection, and the page's ONE navigation axis: an inventory
   * entry ("all" or a kind key), an analysis view (a PANELS key), or
   * "flagged".
   *
   * It replaces the old mode / kinds / panel triple, which was three controls
   * answering one question — what am I looking at — spread across three bands
   * of chrome. Navigation is not a filter: it sits outside isFiltered, clear
   * and esc, because clearing your filters must never silently change what
   * kind of thing you are looking at.
   */
  nav: string;
  /**
   * Draw the headline figures above the content. Ordinary view state, held
   * here like every other — it does not survive a reload, and toggling it
   * changes only whether the figures are drawn, never what they say.
   */
  statBar: boolean;
  /**
   * Which calibration of the palette to draw: the canonical dark instrument,
   * the light bench manual, or whatever the system asks for. Held here like
   * every other view state — main.ts stamps it on the root element — and
   * neither setting changes a single figure.
   */
  theme: "auto" | "dark" | "light";
  /** The full provenance statement and its caveats, opened from the sidebar foot. */
  provOpen?: boolean;
  /**
   * Rows the prune shortlist has checked for disabling. Ids, so the set
   * survives a re-sort; cleared whenever the payload is replaced, because a
   * toggle moves a directory and the path-derived ids move with it.
   */
  checked?: string[];
  /**
   * An explicit id set the table is narrowed to: what a prune-quadrant click
   * produces. It carries its own label because it is rendered as a chip in the
   * view controls — a filter with nothing on screen to turn off is the one
   * thing this page must never hold.
   */
  focus?: { label: string; ids: string[] };
  /** Activity log lines, oldest first; the panel renders only when non-empty. */
  log: LogEntry[];
  logOpen?: boolean;
  /** Active provider filters; empty means all. */
  providers: string[];
  /** Free-text match over name, description and path. */
  query: string;
  /** The activity lens. "off" is the disabled set; flagged is a destination now. */
  lens: "all" | "fired" | "never-fired" | "off";
  sort: { key: SortKey; dir: 1 | -1 };
  selected?: string;
  /** Toggle failure to render in the drawer — never a silent no-op. */
  error?: string;
  busy?: boolean;
  /** Replay the load choreography (first paint and rescan only). */
  animate?: boolean;
  sweep?: boolean;
  /**
   * Event ids whose transcript the server reported deleted (410). The rows
   * stay listed — the ledger event is retained — but render disabled, stating
   * that fact instead of offering a dead open button.
   */
  purgedEvents?: string[];
}

export function defaultState(): AppState {
  return {
    nav: "all",
    statBar: true,
    theme: "auto",
    log: [],
    providers: [],
    query: "",
    lens: "all",
    sort: { key: "injected", dir: -1 },
    animate: true,
    sweep: true,
  };
}

/**
 * The state the app actually boots with: skills-first. Skills are the layer
 * you act on — togglable, auto-triggering, the thing this dashboard manages —
 * so the sidebar opens on them; everything else is one entry away. A payload
 * with no skills at all (a Codex-only or Cursor-only machine) boots to the
 * full inventory instead of an empty table.
 */
export function initialState(payload: UiPayload): AppState {
  const s = defaultState();
  if (payload.items.some((i) => i.kind === "skill")) s.nav = "skill";
  return s;
}

/** Any filter narrowing the content, which is what a "clear" control acts on. */
export const isFiltered = (s: AppState): boolean =>
  s.providers.length > 0 ||
  s.lens !== "all" ||
  s.query.trim() !== "" ||
  (s.focus?.ids.length ?? 0) > 0;

/**
 * The inventory kinds, in the order the sidebar lists them: the layer you act
 * on first, then what the model dispatches, then what you type, then what is
 * simply always there.
 */
export const KIND_ORDER = ["skill", "agent", "command", "prompt", "rule", "instructions"];

/** Sidebar wording. `fires` stays the product's noun; kinds get plain plurals. */
export const KIND_LABEL: Record<string, string> = {
  skill: "skills",
  agent: "agents",
  command: "commands",
  prompt: "prompts",
  rule: "rules",
  instructions: "instructions",
};

const isKindNav = (n: string): boolean => KIND_ORDER.includes(n);

/**
 * Everything interpolated into markup goes through here. The payload carries
 * attacker-controlled text — skill names, descriptions, security evidence —
 * and a dashboard for a security tool being XSS-able from the files it audits
 * would be the whole pitch inverted.
 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tabular figures with comma grouping: 18342 → "18,342". */
export function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export const tokens = (chars: number): number => Math.ceil(chars / 4);
const fmtDay = (iso?: string): string => (iso ? iso.slice(0, 10) : "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date for reading, not for filing: "Aug 5" inside the scan's own year,
 * "Aug 5 2025" outside it. The year is not dropped silently — a bare "Aug 5"
 * that is really eleven months old would be the same class of overclaim as a
 * fire count with no window on it. Both parts come from the ISO string, never
 * from the viewer's clock, so the same payload reads the same tomorrow.
 */
function fmtMon(iso?: string, asOf?: string): string {
  if (!iso) return "";
  const d = fmtDay(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const day = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
  return asOf && asOf.slice(0, 4) === m[1] ? day : `${day} ${m[1]}`;
}

const DAY = 86_400_000;

/**
 * Whole days from `iso` to the payload's scan stamp — the page's only clock.
 * Date.now() would make the same payload render differently tomorrow.
 */
function daysAgo(iso: string, asOf?: string): number | undefined {
  if (!asOf) return undefined;
  const a = Date.parse(iso);
  const b = Date.parse(asOf);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.max(0, Math.floor((b - a) / DAY));
}

/** Compact figure for sub-lines: 31200 → "31k", 7750 → "7.8k", 480 → "480". */
export function fmtK(n: number): string {
  if (n < 1000) return fmtInt(n);
  return n < 10_000 ? `${Math.round(n / 100) / 10}k` : `${Math.round(n / 1000)}k`;
}

/**
 * The payload stamps UTC; this renders in the viewer's own zone. Slicing the
 * ISO string dropped the `Z` and showed UTC as if it were local time — a
 * readout that is quietly several hours wrong is worse than no readout.
 */
function fmtStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19).replace("T", " ");
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * How far back the local transcripts actually reach.
 *
 * This is the single most important qualifier on the page. The usage window is
 * a RETENTION window: Claude Code deletes old sessions, so the scan can only
 * ever see as far back as the oldest surviving transcript. A skill used
 * heavily six months ago and not since is indistinguishable — to any tool
 * reading this data — from one that was never used at all. Saying "never"
 * without the window attached is a claim the data cannot support, so every
 * place that number appears carries the window with it.
 */
export interface Window {
  /** "42d", or "" when no history was scanned. */
  span: string;
  /** Long-form explanation, used as the title on every usage figure. */
  note: string;
  /** Short qualifier for table cells: "none in 42d". */
  none: string;
  /** The payload's scan stamp — the deterministic "now" behind every age figure. */
  asOf?: string;
  /**
   * The window's start ISO stamp. The dead-weight age gate compares install
   * dates against it — the same predicate the header rent figure uses, so the
   * two surfaces can never disagree about what is too new to judge.
   */
  start?: string;
  /**
   * When the snapshot history recorded the skill listing crossing its budget,
   * if ever — the anchor for the quiet-onset annotation. Rides the Window so
   * every surface that renders a quiet verdict can reach it.
   */
  listingCrossedAt?: string;
  /**
   * Each provider's OWN window, as a Window in its own right.
   *
   * Retention is not shared: Claude Code deletes transcripts within weeks,
   * Codex keeps rollouts for months, and Cursor's conversation store reaches
   * back further still — which is why `inventory.ts` never folds cursor into
   * the merged window above. A count taken out of one store and captioned with
   * the merged span claims a horizon that store never had, so every surface
   * resolves a row through `windowFor` before printing a span beside it.
   *
   * Carried ON the merged Window rather than looked up from the payload
   * because the surfaces that need it — the drawer above all — are handed a
   * Window and never the payload.
   */
  byProvider?: Partial<Record<SourceId, Window>>;
  /**
   * Was the durable ledger readable for this scan? Rides the Window for the
   * same reason `byProvider` does — the drawer is handed a Window, never the
   * payload — and it is the ONLY reliable signal: a tracked row that never
   * fired carries `fires === null` and therefore no `trackedSince`, so an
   * absent tracking date says nothing about whether the store opened.
   */
  ledgerOk?: boolean;
}

/** What each provider's local store IS, named wherever its window is explained. */
const PROVIDER_STORE: Partial<Record<SourceId, string>> = {
  claude: "the local Claude Code transcripts",
  codex: "the local Codex rollouts",
  cursor: "Cursor's local conversation store",
};

/**
 * One provider's window, with days counted exactly the way the merged window
 * counts them — two spans printed side by side have to be the same measurement.
 * A half-dated range claims no span at all: "42d" derived from one end is a
 * figure nothing measured.
 */
function providerWindow(source: SourceId, w: { start?: string; end?: string }, payload: UiPayload): Window {
  const store = PROVIDER_STORE[source] ?? `${source}'s own local store`;
  const listingCrossedAt = payload.header.listing?.crossedAt;
  const from = w.start ? Date.parse(w.start) : NaN;
  const to = w.end ? Date.parse(w.end) : NaN;
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return {
      span: "",
      note:
        `Counts on this row come from ${store}, which this scan could date only partially ` +
        `(${fmtDay(w.start) || "?"} → ${fmtDay(w.end) || "?"}), so no span is claimed for them.`,
      none: "no data",
      asOf: payload.generatedAt,
      start: w.start,
      listingCrossedAt,
    };
  }
  const days = Math.max(1, Math.round((to - from) / DAY));
  const span = `${days}d`;
  return {
    span,
    note:
      `Counts on this row come from ${store}, covering ${fmtDay(w.start)} → ${fmtDay(w.end)} ` +
      `(${days} days) — this provider's own window, not the merged transcript window on the page ` +
      `header. Each harness keeps a different amount of history, so counts from two providers are ` +
      `not like-for-like, and a fire before ${fmtDay(w.start)} cannot be counted here.` +
      (source === "cursor"
        ? ` A Cursor conversation carries one creation date, so every rule attachment inside it is dated by that conversation rather than by itself.`
        : ""),
    none: `none in ${span}`,
    asOf: payload.generatedAt,
    start: w.start,
    listingCrossedAt,
    ledgerOk: !payload.ledgerCaveat,
  };
}

export function usageWindow(payload: UiPayload): Window {
  const h = payload.history;
  const listingCrossedAt = payload.header.listing?.crossedAt;
  let byProvider: Partial<Record<SourceId, Window>> | undefined;
  for (const [source, w] of Object.entries(payload.providerWindows ?? {})) {
    if (!w || (w.start === undefined && w.end === undefined)) continue;
    byProvider = byProvider ?? {};
    byProvider[source as SourceId] = providerWindow(source as SourceId, w, payload);
  }
  if (!h?.windowStart || !h?.windowEnd) {
    // No merged transcript window is NOT "no usage anywhere": a Cursor-only
    // machine has a real, dated store and no transcripts at all, and its rows
    // resolve through byProvider below.
    return {
      span: "",
      note: "no local transcripts were scanned, so no usage can be counted",
      none: "no data",
      asOf: payload.generatedAt,
      listingCrossedAt,
      byProvider,
      ledgerOk: !payload.ledgerCaveat,
    };
  }
  const days = Math.max(
    1,
    Math.round((Date.parse(h.windowEnd) - Date.parse(h.windowStart)) / 86_400_000)
  );
  const span = `${days}d`;
  return {
    span,
    note:
      `Counts come from the ${h.transcriptFiles} local transcripts still on this machine, ` +
      `covering ${fmtDay(h.windowStart)} → ${fmtDay(h.windowEnd)} (${days} days). ` +
      `Older sessions are deleted by Claude Code and cannot be counted — a skill you used ` +
      `before ${fmtDay(h.windowStart)} shows zero fires here. This is "not used lately", not "never used".`,
    none: `none in ${span}`,
    asOf: payload.generatedAt,
    start: h.windowStart,
    listingCrossedAt,
    byProvider,
    ledgerOk: !payload.ledgerCaveat,
  };
}

/**
 * Which provider's store produced a row's fire figures.
 *
 * `custom` is a Claude-format asset audited from an explicit directory — the
 * same transcripts. An AGENTS.md's activations are LOAD events recorded by the
 * Codex rollout scan that read it, which is the window `inventory.ts` counts
 * them over, so it is the window they must be captioned with.
 */
export function evidenceSource(item: UiItem): SourceId {
  if (item.source === "custom") return "claude";
  if (item.source === "agents-md") return "codex";
  return item.source;
}

/**
 * The window a row's own figures were actually measured over. Falls back to
 * the merged window when the payload carries none for that provider — an
 * older payload, or a provider whose store this scan never opened.
 *
 * Idempotent: a provider Window carries no `byProvider` of its own, so a
 * surface that resolves twice gets the same window both times.
 */
export function windowFor(win: Window, item: UiItem): Window {
  return win.byProvider?.[evidenceSource(item)] ?? win;
}

/**
 * Providers whose windows differ from the merged one, as "codex 154d · cursor
 * 83d" — the qualifier a page-level caption needs when the rows beneath it were
 * counted over different horizons. Empty when nothing differs.
 */
function otherWindows(win: Window, items?: UiItem[]): string {
  const entries = Object.entries(win.byProvider ?? {}) as [SourceId, Window][];
  const present = items ? new Set(items.map(evidenceSource)) : undefined;
  // Both ends decide identity: two windows of equal length starting on
  // different days are different windows, and the age gate compares starts.
  return entries
    .filter(([s, w]) => (w.span !== win.span || w.start !== win.start) && (!present || present.has(s)))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, w]) => `${s} ${w.span || "undated"}`)
    .join(" · ");
}

/**
 * Providers whose sessions `history.transcriptFiles` actually counts: Claude
 * transcripts, plus Codex rollouts where codex prompts exist. Cursor is
 * deliberately never folded into that total (inventory.ts), so a cursor row's
 * conversations have no comparable denominator on this payload — and a share
 * taken of a total from another store is a percentage of nothing.
 */
const TRANSCRIPT_SESSIONS = new Set<SourceId>(["claude", "custom", "codex", "agents-md"]);
const comparableSessions = (item: UiItem): boolean => TRANSCRIPT_SESSIONS.has(item.source);

/**
 * What a session IS for this row's provider. Cursor records conversations, not
 * sessions, and calling them sessions invites exactly the cross-store division
 * this file refuses to perform.
 */
const sessionNoun = (item: UiItem): string =>
  item.source === "cursor" ? "conversation" : "session";

/**
 * Dead weight: enabled, no fires at all, paying at least a quarter of what the
 * priciest item pays, and installed before ITS OWN provider's window opened.
 *
 * ONE implementation, exported, because three surfaces render this verdict —
 * the header's rent total (summed by inventory.ts over the same age gate), the
 * prune quadrant's amber marks and the cost column's amber cells. Two of them
 * used to gate on the MERGED window start, which is the minimum across
 * providers, so the same payload could call an item dead weight in the header
 * and not in the table. The header's rent has no cost-share gate — it is a sum
 * over every age-gated silent item, not only the priciest quarter — so the
 * figures differ by construction; the SET each one judges must not.
 */
export function isDeadWeight(item: UiItem, maxInjected: number, win: Window): boolean {
  const w = windowFor(win, item);
  const pct =
    item.injectedChars > 0 && maxInjected > 0
      ? Math.max(3, Math.round((item.injectedChars / maxInjected) * 100))
      : 0;
  const preDatesWindow =
    item.provenance !== undefined && !!w.start && item.provenance.installedAt < w.start;
  return item.enabled && item.fires === null && pct >= 25 && !!w.span && preDatesWindow;
}

const flagCount = (i: UiItem): number => i.findings.filter((f) => f.level === "flag").length;
const hasHigh = (i: UiItem): boolean =>
  i.findings.some((f) => f.level === "flag" && (f.severity === "critical" || f.severity === "high"));

/**
 * The count every ledger-derived facet is measured over: the durable lifetime
 * figure where the join supplied one, the transcript-window count otherwise.
 * The facets themselves (spread, quiet, byModel…) are computed from ledger
 * events, so quoting the window count beside them would state two different
 * denominators as one.
 */
const firesCount = (f: UiFires): number => f.lifetime?.invocations ?? f.invocations;

/** "1 fire" / "2 fires" — `s` alone is a variable name three functions here use. */
const plural = (n: number): string => (n === 1 ? "" : "s");

// --- the qualifier rule -----------------------------------------------------
//
// Invariant 6 restated: no figure may be presentable as something it is not.
// That is satisfied by TWO mechanisms and not by repetition — one provenance
// statement covering the page, and a deviation mark on any figure the
// statement does not describe.
//
// The page used to satisfy it the other way: every element carried its full
// derivation, 21,357 words across 490 elements. Because everything was equally
// explained, nothing was learnable. A figure that matches the page-level
// provenance now carries NOTHING; the six deviations below are the complete
// list of things that earn a mark, and they are not negotiable.

export type Deviation = "window" | "backfilled" | "modelled" | "unmeasured" | "bound" | "approx";

/** The legend's index: which kinds are on this page, in one word each. */
export const DEVIATION_LABEL: Record<Deviation, string> = {
  window: "another provider's window",
  backfilled: "backfilled",
  modelled: "modelled",
  unmeasured: "unmeasured",
  bound: "an upper bound",
  approx: "approximate",
};

/** What each mark MEANS, worded identically wherever it is read. */
export const DEVIATION_TERM: Record<Deviation, string> = {
  window: "measured over a different provider's window",
  backfilled: "backfilled — imported rather than observed",
  modelled: "modelled — our reconstruction of something the harness keeps to itself",
  unmeasured: "unmeasured — absent, which is not zero",
  bound: "an upper bound, not a reading",
  approx: "approximate, by a stated method",
};

/**
 * ONE mark, everywhere. Its own sentence rides it for the detail; the
 * provenance statement carries the legend naming every kind present on the
 * page. Two marks would be a second colour rule in disguise.
 */
export function dev(kind: Deviation, detail: string): string {
  return `<b class="dev" data-dev="${kind}" title="${esc(`${DEVIATION_TERM[kind]} — ${detail}`)}">°</b>`;
}

/**
 * Which deviations this payload actually contains. The legend lists only
 * these: naming a kind that appears nowhere would teach a reader to look for
 * something that is not on the page — the same failure as a chip counting
 * zero rows.
 */
export function deviationsPresent(payload: UiPayload): Deviation[] {
  const win = usageWindow(payload);
  const out: Deviation[] = [];
  if (otherWindows(win, payload.items)) out.push("window");
  if (payload.history?.backfilledSince) out.push("backfilled");
  if (payload.budgetCut && payload.budgetCut.order.length > 0) out.push("modelled");
  if (payload.ledgerCaveat || payload.items.some((i) => i.fires === undefined)) out.push("unmeasured");
  if (payload.items.some((i) => i.disabledSafety?.disabledAtSource === "ctime")) out.push("bound");
  if (payload.items.some((i) => i.agentCost)) out.push("approx");
  return out;
}

/**
 * Kind identity. One calibrated signal color means kinds cannot be color-coded,
 * so shape does the work: a filled marker for skills (the primary, togglable
 * object on the page), hollow for agents, and text glyphs for the rest. The
 * glyph repeats in the kind cells and the filter chips so the two read as the
 * same vocabulary.
 */
export const KIND_GLYPH: Record<string, string> = {
  skill: "◆",
  agent: "◇",
  command: "/",
  prompt: "/",
  rule: "§",
  instructions: "≡",
};

export const KIND_NOTE: Record<string, string> = {
  skill: "A skill: auto-triggers when your request matches its description, or via /name. Its body loads only when it runs.",
  // Agent rows ARE dispatch-tracked: the model launches a subagent through the
  // Agent/Task tool, and that tool_use is what the transcript walk banks as an
  // auto-channel fire. This note claimed the opposite for as long as no such
  // join existed; leaving it would tell readers to disbelieve real counts.
  agent: "An agent: a subagent definition the model launches through the Agent/Task tool. Its description is always in context, and every launch is recorded — banked as an auto-channel fire — so its fire count is a real dispatch count. It reads n/a only where this scan could not read the durable ledger those launches are banked in: an absent measurement, never a zero.",
  command: "A slash command: fires only when you type /name.",
  prompt: "A Codex prompt: fires only when you type /name.",
  // What a Cursor "fire" IS, stated outright: an attachment recorded against a
  // message, dated by its conversation. A load count read as an auto-dispatch
  // count is the one misreading this row invites.
  rule: "A Cursor rule: applies by glob, always, or on request depending on its frontmatter. A \"fire\" here is a rule ATTACHMENT recorded against a message in Cursor's local conversation store, dated by that conversation's creation time — how often the rule was loaded, never how often a model chose to dispatch it.",
  instructions: "An instruction file (CLAUDE.md / AGENTS.md): its whole body is in context in every session.",
};

/**
 * Which link of the install-date fallback chain produced the date. Stated
 * next to every date it qualifies: a manifest entry, a file birthtime and a
 * last-edit mtime are different-strength claims, and the reader is told which
 * one they are looking at.
 */
export const PROVENANCE_LABEL: Record<ProvenanceSource, string> = {
  "plugin-manifest": "the plugin manifest's install record",
  birthtime: "file creation time on this machine",
  git: "first added in git history",
  mtime: "file modification time — a last edit, not an install date",
  "first-seen": "first sighting by this tool's ledger",
};

/** An mtime date is a last edit; calling it an install would overclaim. */
const provVerb = (p: Provenance): string => (p.source === "mtime" ? "edited" : "installed");

export type Trend = "rising" | "flat" | "quiet" | "new";

export const TREND_GLYPH: Record<Trend, string> = { rising: "↗", flat: "→", quiet: "↘", new: "∗" };

/**
 * Four-week comparison measured back from the scan stamp: fires in the last 4
 * ISO weeks vs the 4 before. Counts, not curve-fitting — the glyph's title
 * states the two numbers the verdict was decided on.
 */
export function trendOf(
  bins: { weekStart: string; count: number }[] | undefined,
  asOf: string | undefined
): { trend: Trend; recent: number; prior: number } | undefined {
  if (!bins || bins.length === 0 || !asOf) return undefined;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return undefined;
  let recent = 0;
  let prior = 0;
  let oldest = Infinity;
  for (const b of bins) {
    const w = Date.parse(b.weekStart);
    if (Number.isNaN(w) || b.count <= 0) continue;
    oldest = Math.min(oldest, w);
    if (w > t - 28 * DAY) recent += b.count;
    else if (w > t - 56 * DAY) prior += b.count;
  }
  if (oldest === Infinity) return undefined;
  if (recent === 0) return { trend: "quiet", recent, prior };
  if (oldest > t - 28 * DAY) return { trend: "new", recent, prior };
  return { trend: recent > prior ? "rising" : "flat", recent, prior };
}

/**
 * The quiet-onset budget annotation: when a claude-listed skill went quiet
 * AROUND the time the skill listing crossed its budget, the two dated facts
 * are stated side by side. Correlation offered, never asserted — an over-
 * budget listing drops least-fired descriptions, which stops auto-triggering,
 * so the timing is worth checking; it is not proof. "Around" is a hard
 * 28-day proximity between the last fire and the crossing — the same span
 * the quiet verdict itself is measured over. Empty string when any link of
 * that chain is missing: no crossing recorded, not listed, not quiet.
 */
function quietBudgetNote(item: UiItem, f: UiFires, win: Window): string {
  if (!win.listingCrossedAt || !item.enabled || item.kind !== "skill") return "";
  if (item.source !== "claude" && item.source !== "custom") return "";
  const t = trendOf(f.weeklyBins, win.asOf);
  if (!t || t.trend !== "quiet") return "";
  const lastFired = f.lifetime?.lastFired ?? f.lastFired;
  if (!lastFired) return "";
  const fired = Date.parse(lastFired);
  const crossed = Date.parse(win.listingCrossedAt);
  if (Number.isNaN(fired) || Number.isNaN(crossed) || Math.abs(crossed - fired) > 28 * DAY) return "";
  const age = daysAgo(lastFired, win.asOf);
  return (
    `last fired ${age !== undefined ? `${fmtInt(age)}d ago` : fmtDay(lastFired)} — around when your skill listing went over budget (${fmtDay(win.listingCrossedAt)}). ` +
    `Over budget, Claude Code drops the least-fired skills' descriptions, which stops auto-triggering — a timing worth checking, not a verdict.`
  );
}

/**
 * Cost per recorded fire, window figures on both sides of the division:
 * (always-in-context cost × sessions + body cost × fires) ÷ fires. Lifetime
 * fires are never mixed in — they have no matching session denominator.
 * Undefined when there is nothing to divide by; the cell states what WAS
 * paid instead, and sorting handles that case explicitly — never Infinity,
 * never NaN.
 */
export function tokPerFire(item: UiItem, totalSessions: number): number | undefined {
  const f = item.fires;
  if (!f || f.invocations <= 0) return undefined;
  // The session multiplier has to come from the same store as the fires. A
  // cursor rule priced at the machine's Claude transcript count would state a
  // per-fire cost built out of sessions Cursor was never in.
  if (!comparableSessions(item)) return undefined;
  const sessions = Math.max(totalSessions, f.sessions);
  return Math.ceil((item.injectedChars * sessions + item.bodyChars * f.invocations) / 4 / f.invocations);
}

// --- filtering and sorting (pure, exercised directly by the smoke test) ----

const matchQuery = (i: UiItem, q: string): boolean =>
  !q ||
  i.name.toLowerCase().includes(q) ||
  (i.description ?? "").toLowerCase().includes(q) ||
  i.path.toLowerCase().includes(q);
const matchProviders = (i: UiItem, providers: string[]): boolean =>
  providers.length === 0 || providers.includes(i.source);
const matchLens = (i: UiItem, lens: AppState["lens"]): boolean => {
  switch (lens) {
    case "never-fired":
      return i.fires === null;
    case "fired":
      return !!i.fires;
    case "off":
      return !i.enabled;
    default:
      return true;
  }
};

/**
 * Every analysis view this MACHINE has a question for.
 *
 * An entry appears only when it has something to show — the same rule that has
 * always governed panels with no data, applied to navigation. The listing is a
 * Claude Code mechanic and a Codex- or Cursor-only setup is not subject to it;
 * an overlap matrix needs two harnesses to cross; growth needs a week on
 * record; the prune scatter needs at least one item with both coordinates.
 * Offering a door onto a blank room is the same claim as printing a 0 for a
 * measurement nothing took.
 */
export function analysisApplies(key: string, payload: UiPayload): boolean {
  switch (key) {
    case "prune":
      return payload.items.some((i) => i.enabled && i.fires !== undefined);
    case "budget":
      return !!payload.header.listing || !!payload.budgetCut;
    case "overlap":
      return new Set(payload.items.map((i) => i.source)).size > 1;
    // A delta with no weekly series still belongs here: it is the same
    // question — is the pile growing — measured over one scan interval instead
    // of over ISO weeks, and the view states both.
    case "growth":
      return (payload.growth?.weeks.length ?? 0) > 0 || !!payload.delta;
    default:
      return false;
  }
}

const ANALYSIS_KEYS = ["prune", "budget", "overlap", "growth"];

/**
 * The nav entry actually in play, falling back to the whole inventory for
 * anything this payload cannot render — a kind that no longer exists after a
 * rescan, an analysis view whose evidence disappeared. Resolved in one place so
 * the sidebar's lit entry and the drawn view can never disagree.
 */
export function navKey(payload: UiPayload, state: AppState): string {
  const n = state.nav;
  if (n === "flagged") return n;
  if (isKindNav(n)) return payload.items.some((i) => i.kind === n) ? n : "all";
  if (ANALYSIS_KEYS.includes(n)) return analysisApplies(n, payload) ? n : "all";
  return "all";
}

export const isAnalysisNav = (payload: UiPayload, state: AppState): boolean =>
  ANALYSIS_KEYS.includes(navKey(payload, state));

/** What the current nav entry can show at all — the base every filter works within. */
export function navBase(payload: UiPayload, state: AppState): UiItem[] {
  const n = navKey(payload, state);
  if (n === "flagged") return payload.items.filter((i) => flagCount(i) > 0);
  if (isKindNav(n)) return payload.items.filter((i) => i.kind === n);
  return payload.items;
}

/**
 * The pinned id set, as a Set for the row loops. Undefined when nothing is
 * pinned — every caller then skips the test entirely rather than testing
 * against an empty set that would hide the whole inventory.
 */
const focusIds = (state: AppState): Set<string> | undefined =>
  state.focus && state.focus.ids.length > 0 ? new Set(state.focus.ids) : undefined;

/**
 * The activity-log verdict for a plugin update, decided by DATA — the
 * version the rescan actually found — never by the CLI's prose. "updated"
 * when nothing changed is exactly the kind of claim this tool exists to
 * never make.
 */
export function pluginUpdateSummary(name: string, before?: string, after?: string): string {
  if (before && after && before !== after) {
    return `${name} updated ${before} → ${after} — restart Claude Code to pick it up`;
  }
  const v = after ?? before;
  return `${name} is already at the latest version${v ? ` (${v})` : ""} — nothing changed`;
}

/**
 * Called on every nav change: a filter must never outlive the control that
 * shows it. The provider bank only renders where more than one provider is in
 * the base, so a provider filter surviving into a nav entry that holds one
 * would be an INVISIBLE narrowing with nothing on screen to turn off. The
 * size>1 guard mirrors the bank-rendering rule exactly.
 */
export function pruneFiltersForNav(payload: UiPayload, state: AppState): void {
  const present = new Set<string>(navBase(payload, state).map((i) => i.source));
  state.providers = present.size > 1 ? state.providers.filter((v) => present.has(v)) : [];
}

export function visibleItems(payload: UiPayload, state: AppState): UiItem[] {
  const q = state.query.trim().toLowerCase();
  const pinned = focusIds(state);
  return sortItems(
    navBase(payload, state).filter(
      (i) =>
        (!pinned || pinned.has(i.id)) &&
        matchQuery(i, q) &&
        matchProviders(i, state.providers) &&
        matchLens(i, state.lens)
    ),
    state.sort,
    payload.history?.transcriptFiles ?? 0
  );
}

/**
 * Every live count on the chrome: sidebar entries and provider chips.
 *
 * Faceted, so a number always predicts exactly what clicking it will show —
 * a sidebar entry counts the items that survive the current lens, search and
 * provider filters, and a provider chip counts within the current nav entry.
 * Exported on its own because the query is one of those dimensions: typing
 * must update the counts WITHOUT rebuilding the controls (the search input is
 * the node the caret lives in), so main.ts patches the count nodes in place.
 *
 * `flagged` is the one exception, and deliberately: security is never reduced
 * by a presentation default, so it counts the whole payload — and clicking it
 * clears the lens and query, so the number it printed is the number it shows.
 */
export function liveCounts(
  payload: UiPayload,
  state: AppState
): { group: "nav" | "provider"; key: string; count: number }[] {
  const q = state.query.trim().toLowerCase();
  const pinned = focusIds(state);
  const filtered = (items: UiItem[]): UiItem[] =>
    items.filter((i) => (!pinned || pinned.has(i.id)) && matchQuery(i, q) && matchLens(i, state.lens));
  const forNav = filtered(payload.items).filter((i) => matchProviders(i, state.providers));
  const out: { group: "nav" | "provider"; key: string; count: number }[] = [
    { group: "nav", key: "all", count: forNav.length },
  ];
  for (const k of KIND_ORDER) {
    if (payload.items.some((i) => i.kind === k)) {
      out.push({ group: "nav", key: k, count: forNav.filter((i) => i.kind === k).length });
    }
  }
  out.push({
    group: "nav",
    key: "flagged",
    count: payload.items.filter((i) => flagCount(i) > 0).length,
  });
  const forProviders = filtered(navBase(payload, state));
  for (const s of [...new Set(navBase(payload, state).map((i) => i.source))].sort()) {
    out.push({ group: "provider", key: s, count: forProviders.filter((i) => i.source === s).length });
  }
  return out;
}

function sortItems(items: UiItem[], sort: AppState["sort"], sessions: number): UiItem[] {
  void sessions;
  const key = (i: UiItem): string | number => {
    switch (sort.key) {
      case "name":
        return i.name.toLowerCase();
      case "source":
        return i.source;
      case "scope":
        return i.scope;
      case "injected":
        return i.injectedChars;
      // One activity column, so one activity sort — on the figure the cell
      // actually leads with. "n/a — no dispatch record" is not a low fire
      // count, it is the absence of the measurement, so it sorts to the BOTTOM
      // in BOTH directions: a tracked zero — the row that really does mean
      // never used — is never buried under rows the data cannot speak to.
      case "activity":
        return i.fires === undefined
          ? sort.dir === 1
            ? Number.MAX_SAFE_INTEGER
            : -1
          : i.fires?.lifetime?.invocations ?? i.fires?.invocations ?? 0;
      case "findings":
        return flagCount(i) * 10 + (hasHigh(i) ? 5 : 0);
      case "state":
        return i.enabled ? 1 : 0;
    }
  };
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const cmp = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
    return cmp !== 0 ? cmp * sort.dir : a.name.localeCompare(b.name);
  });
}

/** Plugin rows stay grouped by plugin (read-only in v1); the rest sort freely. */
export function grouped(items: UiItem[]): {
  loose: UiItem[];
  groups: { plugin: string; version: string; marketplace?: string; latest?: string; items: UiItem[] }[];
} {
  const loose = items.filter((i) => !i.plugin);
  const byPlugin = new Map<string, UiItem[]>();
  for (const i of items) {
    if (!i.plugin) continue;
    const k = `${i.plugin.name}@${i.plugin.marketplace ?? ""}#${i.plugin.version}`;
    byPlugin.set(k, [...(byPlugin.get(k) ?? []), i]);
  }
  const groups = [...byPlugin.values()].map((g) => ({
    plugin: g[0].plugin!.name,
    version: g[0].plugin!.version,
    marketplace: g[0].plugin!.marketplace,
    latest: g[0].plugin!.latest,
    items: g,
  }));
  groups.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return { loose, groups };
}

// --- components ------------------------------------------------------------

/** Oscilloscope-edge calibration ruler; the load sweep travels along it. */
function graticule(): string {
  const parts: string[] = [];
  for (let x = 0; x <= 2400; x += 10) {
    const major = x % 100 === 0;
    parts.push(
      `<line x1="${x}" y1="${major ? 12 : 19}" x2="${x}" y2="24" stroke="currentColor" stroke-width="1" opacity="${major ? 0.5 : 0.22}"/>`
    );
    if (major && x > 0 && x < 2400) {
      parts.push(
        `<text x="${x + 3}" y="10" font-size="7" fill="currentColor" opacity="0.4" font-family="inherit">${String(x / 100).padStart(2, "0")}</text>`
      );
    }
  }
  return `<svg class="grat" viewBox="0 0 2400 24" preserveAspectRatio="xMinYMax slice" aria-hidden="true">${parts.join("")}</svg>`;
}

/**
 * The stat bar: one shallow row of headline figures above the content.
 *
 * It replaces a 130px band of five hero readouts, each with a sub-line and a
 * paragraph in its tooltip. Four figures, each carrying its own denominator
 * inline, each a link to the view that EXPLAINS it — which is the mechanism
 * that let the explanations go: a figure whose derivation is a click away does
 * not need its derivation attached.
 *
 * Flagged is deliberately absent: it is a sidebar section with its own count,
 * and a security total in two places is a security total that can disagree.
 */
function statBar(payload: UiPayload, state: AppState): string {
  if (!state.statBar) return "";
  const h = payload.header;
  const p = payload.portfolio;
  const figs: string[] = [];
  let idx = 0;
  const fig = (key: string, value: string, label: string, to: string, tone = "", mark = ""): string => {
    const style = state.animate ? ` style="animation-delay:${140 + idx * 60}ms"` : "";
    idx++;
    // `data-readout` is main.ts's handle on a specific figure — the live
    // what-if total appends a projection line to the cost one while a toggle is
    // being acted on, and finding it by position would break the moment a
    // machine has no skill listing to render.
    return `<button class="stat${tone}${state.animate ? " settle" : ""}" data-stat="${esc(key)}" data-readout="${esc(key)}"${style} title="${esc(`opens the ${to}`)}">
      <span class="statfig">${value}${mark ? `<s aria-hidden="true">${mark}</s>` : ""}</span>
      <span class="statlab">${esc(label)}</span>
    </button>`;
  };
  // A raw token count has no scale until it is a slice of the window the model
  // actually has, so the share rides the label — the denominator, attached to
  // the figure it makes readable, the way every figure on this page carries its
  // own.
  figs.push(
    fig(
      "cost",
      fmtInt(h.injectedTokens),
      `tok / session · ${((h.injectedTokens / 200_000) * 100).toFixed(1)}% of a 200K context`,
      "prune view"
    )
  );
  figs.push(
    fig("never", fmtInt(h.neverFired), `never fired · of ${fmtInt(h.tracked)} tracked`, "never-fired inventory")
  );
  // Absent on machines the listing does not apply to, rather than shown as a
  // zero — a budget nothing is subject to is not a fact about this setup.
  if (h.listing) {
    figs.push(
      fig(
        "listing",
        `${fmtInt(h.listing.pct)}%`,
        "of listing budget",
        "listing view",
        h.listing.over ? " dgr" : "",
        h.listing.over ? "▲" : ""
      )
    );
  }
  if (p && p.sessions > 0) {
    // The denominator is the sessions the LEDGER has seen, which is not every
    // session on this machine — named in the label, because a share whose
    // denominator is unstated is not readable at all.
    figs.push(
      fig(
        "used",
        `${fmtInt(p.sessionsWithFires)}/${fmtInt(p.sessions)}`,
        "ledger sessions used anything",
        "growth view"
      )
    );
  }
  return `<div class="statbar">${figs.join("")}</div>`;
}

/**
 * Every qualifier this payload states about its own figures, as sentences.
 * Counted in the sidebar foot and read in full inside the provenance
 * statement — a degraded read is never left silent.
 */
function caveatList(payload: UiPayload): string[] {
  const out: string[] = [];
  if (payload.pluginResolution === "newest-fallback") {
    out.push(
      "Plugin versions came from a newest-cached fallback: installed_plugins.json was missing or unreadable."
    );
  }
  if (payload.ledgerCaveat) out.push(payload.ledgerCaveat);
  out.push(...(payload.caveats ?? []));
  return out;
}

/**
 * Signed diff with a real minus sign, never a hyphen — the figures on this
 * page are typeset, and "-1,204" beside "−205 tok" would be two characters
 * doing one job.
 */
export const signed = (n: number): string => (n > 0 ? `+${fmtInt(n)}` : n < 0 ? `−${fmtInt(-n)}` : "0");

/** Chars → tokens keeping the sign: a diff of −812 chars is −203 tok, not −204. */
export const signedTokens = (chars: number): number => (chars < 0 ? -tokens(-chars) : tokens(chars));

/** The earliest date any row's ledger figures are counted from. */
export function trackedSince(payload: UiPayload): string | undefined {
  return payload.items
    .map((i) => i.fires?.trackedSince)
    .filter((t): t is string => typeof t === "string")
    .sort()[0];
}

// --- sidebar ----------------------------------------------------------------

/** The analysis views, in the order the sidebar lists them. */
const ANALYSIS_ORDER = ["budget", "prune", "overlap", "growth"];
/**
 * What the sidebar calls each one. `listing` and `providers` read as questions
 * about this machine; `budget` and `overlap` were the internal keys, and the
 * keys stay so the panel registry and the payload fields do not have to move.
 */
const ANALYSIS_LABEL: Record<string, string> = {
  budget: "listing",
  prune: "prune",
  overlap: "providers",
  growth: "growth",
};

/**
 * Navigation, drawn as an instrument's function selector.
 *
 * This is the highest-risk element on the page: a left sidebar is the most
 * common shape of an AI-generated dashboard, and the acceptance test in
 * `.impeccable.md` fails on sight of one. So it is built out of the page's
 * existing grammar and nothing else — engraved section labels, hairline
 * separators, tabular counts, one amber for the lit entry, a caret in the
 * gutter. No icons, no pills, no rounded cards, no nested panels, no accent
 * bars, no background fills.
 *
 * Counts are faceted by the lens and search below, so an entry's number always
 * predicts what clicking it shows. `flagged` is the exception, stated where it
 * is made: security is never reduced by a presentation default.
 */
function sidebar(payload: UiPayload, state: AppState): string {
  const active = navKey(payload, state);
  const counts = new Map(liveCounts(payload, state).map((c) => [`${c.group}\0${c.key}`, c.count]));
  const n = (k: string): number => counts.get(`nav\0${k}`) ?? 0;

  // A mark rides an entry only where the page already treats that state as
  // one, in the tone that fact already carries: the listing readout's
  // over-budget --danger, and the findings severity tone. No new colour rule,
  // and no other entry is ever marked.
  const listingMark = payload.header.listing?.over ? `<i class="navmark dgr" aria-hidden="true">▲</i>` : "";
  const flaggedMark =
    payload.header.flaggedHigh > 0
      ? `<i class="navmark dgr" aria-hidden="true">▲</i>`
      : payload.header.flagged > 0
        ? `<i class="navmark sig" aria-hidden="true">▲</i>`
        : "";

  const entry = (key: string, label: string, count: string, mark = "", note = ""): string =>
    `<button class="nav${key === active ? " on" : ""}" data-nav="${esc(key)}"${
      key === active ? ` aria-current="page"` : ""
    }${note ? ` title="${esc(note)}"` : ""}><s aria-hidden="true">${
      key === active ? "▸" : ""
    }</s><span>${esc(label)}</span>${mark}<b>${count}</b></button>`;

  const kinds = KIND_ORDER.filter((k) => payload.items.some((i) => i.kind === k))
    .map((k) => entry(k, KIND_LABEL[k], fmtInt(n(k)), "", KIND_NOTE[k] ?? ""))
    .join("");

  const analysis = ANALYSIS_ORDER.filter((k) => analysisApplies(k, payload))
    .map((k) => entry(k, ANALYSIS_LABEL[k], "", k === "budget" ? listingMark : "", ANALYSIS_NOTE[k]))
    .join("");

  return `<nav class="side" aria-label="views">
    <div class="sidehead">
      <span class="brand">context-audit</span>
      <span class="sidesub">instruction inventory</span>
    </div>
    <div class="navgroup">
      <span class="engr">inventory</span>
      ${entry("all", "all", fmtInt(n("all")))}
      ${kinds}
    </div>
    ${analysis ? `<div class="navgroup"><span class="engr">analysis</span>${analysis}</div>` : ""}
    <div class="navgroup">
      <span class="engr">security</span>
      ${entry(
        "flagged",
        "flagged",
        fmtInt(n("flagged")),
        flaggedMark,
        "Items carrying at least one security flag, counted across the whole inventory. Opening this clears the lens and the search, so the count you see here is the set you get."
      )}
    </div>
    <div class="sidefoot">
      ${provLink(payload, state)}
      <span class="sidestamp">rev ${esc(payload.version)} · ${esc(fmtStamp(payload.generatedAt).slice(11))} · ${fmtInt(payload.tookMs)} ms</span>
      <div class="sideacts">
        <button class="btn rescan" data-rescan${state.busy ? " disabled" : ""}>${state.busy ? "scanning…" : "rescan"}</button>
        <button class="btn vstat${state.statBar ? " on" : ""}" data-statbar aria-pressed="${state.statBar}" title="${esc(
          "Draw the headline figures above the content. Every figure stays exactly what it was either way — this decides only whether they are drawn."
        )}">stats</button>
        <button class="btn vstat" data-theme-toggle title="${esc(
          "Switch between the dark instrument and the light bench manual. Both are calibrated; neither changes a figure."
        )}">${state.theme === "light" ? "dark" : "light"}</button>
      </div>
    </div>
  </nav>`;
}

/** What each analysis view answers — the sidebar's own one-line note. */
const ANALYSIS_NOTE: Record<string, string> = {
  budget:
    "Claude Code's skill listing against its character budget, in the order it drops descriptions — least-invoked first.",
  prune: "Always-in-context cost against recorded fires, split at both medians. The costly-and-quiet quadrant is the shortlist.",
  overlap: "Assets more than one provider reads or fires, with each provider's own counts held apart.",
  growth: "Instruction files owned against instruction files that actually fired, per ISO week.",
};

// --- view controls ----------------------------------------------------------

/**
 * One compact row above the content: the activity lens, the provider filter
 * where more than one provider is on the machine, and search. Kind and scope
 * are gone from here entirely — they are the sidebar.
 *
 * The whole row is withheld on views it cannot act on: the listing bar and the
 * growth series are payload-level readings, and a band of controls that cannot
 * change what sits under them is a band lying about being one. (The stat-bar
 * switch is a page-level display preference, so it lives with the other one —
 * rescan — in the sidebar foot, and stays reachable from every view.)
 */
function viewBar(payload: UiPayload, state: AppState): string {
  const nav = navKey(payload, state);
  if (nav === "budget" || nav === "growth") return "";
  const counts = new Map(liveCounts(payload, state).map((c) => [`${c.group}\0${c.key}`, c.count]));
  const base = navBase(payload, state);

  const lens = (value: AppState["lens"], label: string): string =>
    `<button class="lens${state.lens === value ? " on" : ""}" data-lens="${esc(value)}" aria-pressed="${state.lens === value}">${esc(label)}</button>`;

  const sources = [...new Set(base.map((i) => i.source))].sort();
  const providerChips =
    sources.length > 1
      ? `<span class="vgroup">${sources
          .map(
            (s) =>
              `<button class="chip${state.providers.includes(s) ? " on" : ""}" data-provider="${esc(s)}" aria-pressed="${state.providers.includes(s)}"><span>${esc(s)}</span><b>${fmtInt(counts.get(`provider\0${s}`) ?? 0)}</b></button>`
          )
          .join("")}</span>`
      : "";

  // A pinned id set — a prune quadrant, brought back to the table. It is a
  // filter like any other, so it takes a control of its own with the count it
  // will actually show and one click to release it.
  const pinned = focusIds(state);
  const focusChip =
    state.focus && pinned
      ? `<button class="chip on" data-unfocus aria-pressed="true" title="${esc(
          `${fmtInt(state.focus.ids.length)} row${plural(state.focus.ids.length)} pinned from the prune plot; the count is how many of them this view can show. Click to release the pin — your other filters stay as they are.`
        )}"><span>${esc(state.focus.label)} ✕</span><b>${fmtInt(base.filter((i) => pinned.has(i.id)).length)}</b></button>`
      : "";

  // Always in the DOM, shown by class: typing must never rebuild this row, and
  // the search field is the node the caret lives in.
  const clear = `<button class="clear${isFiltered(state) ? "" : " gone"}" data-clear title="show all ${fmtInt(base.length)} (esc)">clear</button>`;

  return `<div class="viewbar">
    <span class="vgroup vlens">${lens("fired", "fired")}${lens("never-fired", "never fired")}${lens("off", "off")}</span>
    ${providerChips}
    ${focusChip}
    <label class="find">
      <span class="engr">find</span>
      <input type="search" data-search value="${esc(state.query)}" placeholder="name or description"
             spellcheck="false" autocomplete="off" aria-label="filter by name, description or path">
    </label>
    ${clear}
  </div>`;
}

// --- the provenance statement -----------------------------------------------

/**
 * The always-on face of the provenance statement, in the sidebar foot where it
 * costs the content nothing.
 *
 * The full statement used to sit above every view: ~90px of dense qualifier
 * text in the first reading position, which made the least actionable thing on
 * the page the first thing the eye landed on. What stays visible at all times
 * is the part a reader needs to interpret any figure — the window, the
 * tracking date, and the fact that `°` means a figure this does not describe —
 * and the control opens the rest in full.
 */
function provLink(payload: UiPayload, state: AppState): string {
  const win = usageWindow(payload);
  const since = trackedSince(payload);
  const cav = caveatList(payload);
  return `<button class="provlink${state.provOpen ? " on" : ""}" data-prov aria-expanded="${!!state.provOpen}">
    <span><i>window</i>${esc(win.span || "not scanned")}</span>
    ${since ? `<span><i>tracked</i>${esc(fmtDay(since))}</span>` : ""}
    <span><i>caveats</i>${fmtInt(cav.length)}</span>
  </button>`;
}

/**
 * The statement itself, opened from that control.
 *
 * It covers, in one place: how many transcripts were read, the window they
 * cover, when durable tracking began, and what a FIRE is. Every figure that
 * matches it carries nothing at all; every figure that does not carries the
 * one deviation mark, and the legend names the kinds actually present.
 *
 * The individual TERMS are no longer a strip here — each one is defined at its
 * own first appearance instead, which is what the rule always asked for: `cost
 * / session` and `fire` under their column heads, `listing budget` and `dead
 * weight` in the verdict sentences of the views that report them.
 */
function provenanceBlock(payload: UiPayload, state: AppState): string {
  const win = usageWindow(payload);
  const h = payload.history;
  const since = trackedSince(payload);
  const cav = caveatList(payload);
  const devs = deviationsPresent(payload);
  const onInventory = !isAnalysisNav(payload, state);

  const counted = h?.windowStart && h?.windowEnd
    ? `counted from <b>${fmtInt(h.transcriptFiles)}</b> transcript${plural(h.transcriptFiles)} covering ${esc(fmtDay(h.windowStart))} → ${esc(fmtDay(h.windowEnd))} (<b>${esc(win.span)}</b>)`
    : `not countable here — no local transcripts were scanned`;
  const tracking = since
    ? `, and the durable ledger since <b>${esc(fmtDay(since))}</b>`
    : payload.ledgerCaveat
      ? `; the durable ledger could not be read for this scan`
      : "";
  // The backfill horizon is itself a figure this statement carries, and it is
  // a deviation from it: imported, not observed. So it takes the mark rather
  // than a clause — which also means the legend can never name a kind that
  // appears nowhere on the page.
  const backfill = h?.backfilledSince
    ? ` Typed history reaches back to <b>${esc(fmtDay(h.backfilledSince))}</b>${dev(
        "backfilled",
        "Imported from ~/.claude/history.jsonl rather than observed as it happened, and only for the typed channel — no transcript survives that far back."
      )}.`
    : "";
  const retention = win.span
    ? ` Older sessions are deleted, so nothing inside that window means <em>not used lately</em>, not never used.`
    : "";
  const legend =
    devs.length > 0
      ? ` <span class="devlegend"><b class="dev">°</b> marks a figure this does not describe — its own note says how: ${devs
          .map((d) => esc(DEVIATION_LABEL[d]))
          .join(" · ")}.</span>`
      : "";

  // "inventory: 187 files" is not a headline figure — it is context, and this
  // is where context belongs.
  const statement = `<p class="provline"><b>${fmtInt(payload.header.items)}</b> instruction file${plural(payload.header.items)} scanned${payload.header.providers > 1 ? ` across <b>${fmtInt(payload.header.providers)}</b> providers` : ""}. A <em>fire</em> is one recorded dispatch — the model reaching for an item, or you typing its name — ${counted}${tracking}.${backfill}${retention}${legend}</p>`;

  // The page's purpose, once, on the inventory. One line at reading size beats
  // five lines of qualifier text for a first-time visitor, and the qualifiers
  // are a click away in the same place they have always been.
  const lede = onInventory
    ? `<p class="lede">What your AI tools load before you type — what it costs, what never fires, and what is flagged.</p>`
    : "";

  // Closed, this whole block is one line. Open, it is the full statement and
  // every caveat on it — read where the figures it qualifies are, rather than
  // in front of them.
  if (!state.provOpen) return lede ? `<section class="prov">${lede}</section>` : "";

  const caveats =
    cav.length > 0
      ? `<ul class="cav">${cav.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`
      : "";

  return `<section class="prov open" aria-label="provenance">${lede}${statement}${caveats}</section>`;
}

/**
 * Five columns, because there are five questions. Cost and activity are two of
 * them and get one cell each: `fires`, `tok / fire` and `last fired` used to
 * state one fact in three phrasings, each with its own window suffix, and the
 * never-fired row said "never" three times over.
 *
 * `kind` is gone entirely — it is the sidebar, and the glyph rides the name.
 * `provider` and `scope` survive as discriminators the sidebar does not
 * absorb, and appear only where they vary.
 */
const COLS: { key: SortKey; label: string; cls?: string; def?: string }[] = [
  { key: "state", label: "state" },
  { key: "name", label: "name", cls: "c-name" },
  { key: "source", label: "provider" },
  { key: "scope", label: "scope" },
  // The two terms this table introduces are defined under the heads that
  // introduce them. That is what "defined at its first appearance, in the
  // layout" actually asks for — a strip of definitions at the top of the page
  // is a glossary, and a glossary is a thing you have to go and read.
  { key: "injected", label: "cost / session", cls: "c-num", def: "loaded before you type, every session" },
  { key: "activity", label: "activity", cls: "c-act-col", def: "a fire is one recorded dispatch" },
  { key: "findings", label: "flags" },
];

/**
 * A column where every row would print the same word is a fact about the
 * machine, not a discriminator. Uniformity is judged against the NAV entry's
 * base inventory, not the filtered view: columns must not appear and vanish as
 * the lens is clicked.
 */
function activeCols(base: UiItem[]): typeof COLS {
  const varies = (get: (i: UiItem) => string): boolean => new Set(base.map(get)).size > 1;
  return COLS.filter((c) => {
    if (c.key === "source") return varies((i) => i.source);
    if (c.key === "scope") return varies((i) => i.scope);
    return true;
  });
}

/**
 * The cost column is a meter, not just a figure: a fixed track with a fill
 * scaled to the most expensive item in the inventory, so the Pareto shape of
 * the setup — a few items dominating the bill — is visible without reading a
 * single number. Data-bearing, right-anchored against the aligned figures;
 * tonal ink, because amber is reserved for state and severity.
 */
function costCell(item: UiItem, maxInjected: number, mergedWin: Window): string {
  const tok = tokens(item.injectedChars);
  const pct =
    item.injectedChars > 0 && maxInjected > 0
      ? Math.max(3, Math.round((item.injectedChars / maxInjected) * 100))
      : 0;
  // Dead weight — the page's whole pitch in one intersection: paying a real
  // share of the context bill (≥25% of the priciest item) with zero recorded
  // fires. Only this earns amber in the cost column; a cheap silent item and
  // an expensive busy one are both fine. The predicate itself is the shared
  // one — see isDeadWeight — so this cell, the prune quadrant's amber marks
  // and the stat bar's figures cannot disagree about the same item.
  const deadWeight = isDeadWeight(item, maxInjected, mergedWin);
  // The term is defined once, in the terms strip above the table. What rides
  // the cell is only what the strip cannot say: which window THIS row's
  // verdict was reached in, and only where that is not the page's own. The
  // MERGED window has to be the one threaded in for that comparison — handed
  // the row's own window, `windowFor` is idempotent and the test could never
  // be true, so the mark would never appear on the rows that need it.
  const w = windowFor(mergedWin, item);
  const off = w.span !== mergedWin.span || w.start !== mergedWin.start;
  const mark =
    deadWeight && off ? dev("window", `judged in ${item.source}'s own ${w.span || "undated"} window, not the page's`) : "";
  return `<td class="c-num c-cost${deadWeight ? " dw" : ""}"${
    deadWeight ? ` title="${esc("Dead weight: this cost is being paid with nothing recorded against it.")}"` : ""
  }><span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span>${fmtInt(tok)}${mark}</td>`;
}

/**
 * The modeled listing cut, indexed by item id.
 *
 * MODELED is the load-bearing word: Claude Code drops listing descriptions
 * starting with the skills it has seen invoked least, and it keeps those
 * counters to itself. This replays that documented ORDER over the real listing
 * using this ledger's own lifetime counts as the stand-in ranking — so it is a
 * model of the rule, never a readout of the harness's own state. Every surface
 * that renders it says so.
 */
interface CutFact {
  dropped: boolean;
  chars: number;
  fires: number;
  cumChars: number;
  /** Characters that would have to go for THIS row to fit. 0 while it fits. */
  need: number;
  budget: number;
}

interface CutIndex {
  byId: Map<string, CutFact>;
  dropped: number;
  listed: number;
  budget: number;
  headroom: number;
}

function cutIndex(payload: UiPayload): CutIndex | undefined {
  const c = payload.budgetCut;
  if (!c || c.order.length === 0) return undefined;
  const byId = new Map<string, CutFact>();
  for (const o of c.order) {
    byId.set(o.id, {
      dropped: o.dropped,
      chars: o.chars,
      fires: o.fires,
      cumChars: o.cumChars,
      need: Math.max(0, o.cumChars - c.budgetChars),
      budget: c.budgetChars,
    });
  }
  return {
    byId,
    dropped: c.order.filter((o) => o.dropped).length,
    listed: c.order.length,
    budget: c.budgetChars,
    headroom: c.headroomChars,
  };
}

/** Disk footprint of superseded plugin versions — reported, never deleted. */
function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${fmtInt(b / 1e3)} kB`;
  return `${fmtInt(b)} B`;
}

/**
 * Column heads carry the label and nothing else — no `· 43d` suffix, no
 * paragraph in a tooltip. The window is stated once, in the provenance
 * statement above the table, and a row measured over a different one carries
 * the deviation mark on its own cell.
 */
function tableHead(state: AppState, cols: typeof COLS): string {
  const cells = cols
    .map((c) => {
      const active = state.sort.key === c.key;
      const arrow = active ? (state.sort.dir === 1 ? "▴" : "▾") : "";
      // No role="button": that would override the th's columnheader role and
      // cut every cell loose from its header in the accessibility tree. The
      // sort state is announced by aria-sort, which is what it is for.
      const sorted = active ? ` aria-sort="${state.sort.dir === 1 ? "ascending" : "descending"}"` : "";
      return `<th class="${c.cls ?? ""}${active ? " sorted" : ""}" data-sort="${c.key}" tabindex="0"${sorted}><span class="thlab">${esc(c.label)}<s aria-hidden="true">${arrow}</s></span>${c.def ? `<span class="thdef">${esc(c.def)}</span>` : ""}</th>`;
    })
    .join("");
  return `<tr>${cells}<th class="c-act"><span class="sr">actions</span></th></tr>`;
}

function switchCell(item: UiItem): string {
  if (!item.togglable) {
    return `<span class="ro" title="${esc(item.readOnlyReason ?? "read-only")}">—</span>`;
  }
  // `data-saving-chars` is the always-in-context cost this row would stop
  // paying — the figure a live what-if header total is summed from while a
  // toggle is being acted on. Carried on the switch AND on the savings
  // affordance, since either one can start the action.
  const saving = item.enabled ? ` data-saving-chars="${item.injectedChars}"` : "";
  return `<button class="sw${item.enabled ? " on" : ""}" data-toggle="${item.id}"${saving} role="switch" aria-checked="${item.enabled}" aria-label="${item.enabled ? "disable" : "enable"} ${esc(item.name)}" title="${item.enabled ? `disable — stops paying ${fmtInt(tokens(item.injectedChars))} tok every session` : "enable"}"><i></i></button>`;
}

function findingsCell(item: UiItem): string {
  const flags = flagCount(item);
  const parts: string[] = [];
  if (flags > 0) {
    // The count and the severity tone, and nothing else: how much the flagged
    // item is USED is the activity cell's fact, one column to the left, and
    // restating it here was the same figure printed twice on one row.
    parts.push(`<span class="badge ${hasHigh(item) ? "danger" : "signal"}">▲ ${flags}</span>`);
  }
  if (item.parseError) {
    parts.push(`<span class="badge warn" title="the engine could not fully parse this item">couldn&#39;t parse</span>`);
  }
  return parts.length > 0 ? parts.join(" ") : `<span class="none">—</span>`;
}

function nameCell(item: UiItem, cut?: CutFact): string {
  const colon = item.name.indexOf(":");
  const name =
    item.plugin && colon > 0
      ? `<span class="pfx">${esc(item.name.slice(0, colon + 1))}</span>${esc(item.name.slice(colon + 1))}`
      : esc(item.name);
  const off = item.enabled ? "" : `<span class="offtag">off</span>`;
  // A disabled copy whose name also exists enabled never dispatches and can't
  // be re-enabled in place — visibly different from an ordinary "off" row.
  const shadowed =
    item.twinPath && !item.enabled
      ? `<span class="offtag" title="An enabled copy of this dispatch name exists at ${esc(item.twinPath)}. While it does, this copy never dispatches, and toggling is blocked until one copy is removed or renamed.">shadowed</span>`
      : "";
  // Tonal, never amber: this is a modelled position in a drop order, not a
  // severity — and the row it sits on already carries its own state tag. It
  // stays inline because it explains why a skill stopped auto-triggering,
  // which is the one thing a reader cannot infer from anything else on the row.
  const dropped = cut?.dropped
    ? `<span class="offtag cut" title="${esc(
        `At ${fmtInt(cut.cumChars)} cumulative characters this description falls past the ~${fmtInt(cut.budget)}-char listing budget, so Claude Code would not load it — the skill still exists and can still be typed, it just stops auto-triggering. Freeing ${fmtInt(cut.need)} characters brings it back.`
      )}">▸ dropped${dev(
        "modelled",
        "This replays Claude Code's documented drop order — least-invoked first — over your real listing, ranked on this ledger's own lifetime fire counts standing in for counters the harness keeps to itself."
      )}</span>`
    : "";
  return `${name}${off}${shadowed}${dropped}`;
}

/** The fires cell's trend glyph — the verdict and the numbers it rests on, on hover. */
function trendGlyph(f: UiFires, win: Window, budgetNote = ""): string {
  const t = trendOf(f.weeklyBins, win.asOf);
  if (!t) return "";
  const lastFired = f.lifetime?.lastFired ?? f.lastFired;
  const note =
    t.trend === "quiet"
      ? `quiet — 0 fires in the last 4 ISO weeks, measured back from the scan stamp${lastFired ? ` · last fired ${fmtDay(lastFired)}` : ""}${budgetNote ? ` · ${budgetNote}` : ""}`
      : t.trend === "new"
        ? `new — every recorded fire falls inside the last 4 ISO weeks before the scan stamp`
        : `${t.trend} — ${fmtInt(t.recent)} fire${t.recent === 1 ? "" : "s"} in the last 4 ISO weeks vs ${fmtInt(t.prior)} in the 4 before, measured back from the scan stamp`;
  return `<i class="trend" title="${esc(note)}">${TREND_GLYPH[t.trend]}</i>`;
}

/**
 * The activity cell: "is this used?", answered ONCE, in one phrasing.
 *
 * It replaces four columns that stated one fact three times —
 * `fires: never · installed 47d`, `tok/fire: paid 90,383 · never fired`,
 * `last fired: none in 43d` — each with its own window suffix. Four cases, no
 * restatement, and the window is not repeated in any of them: it is in the
 * provenance statement, and a row counted over a DIFFERENT one carries the
 * deviation mark, which is the only thing that statement cannot cover.
 */
function activityCell(item: UiItem, mergedWin: Window, win: Window): string {
  const f = item.fires;
  const noun = sessionNoun(item);
  // Does this row's window match the page's? Both ends decide: two windows of
  // equal length opening on different days are different windows.
  const offWindow = win.span !== mergedWin.span || win.start !== mergedWin.start;
  const windowMark = offWindow
    ? dev(
        "window",
        `counted in ${item.source}'s own store, covering ${win.span || "an undated range"} — not the ${mergedWin.span || "merged"} window on this page.`
      )
    : "";

  // Fires are recorded by dispatch name; a shadowed disabled copy never
  // dispatches, so repeating the name's count here would double-report it.
  if (item.twinPath && !item.enabled) {
    return `<td class="c-act-col na" title="${esc(
      "Fires are recorded by dispatch name, and an enabled copy of this name exists — its row carries the history."
    )}">shadowed</td>`;
  }

  // An absent measurement, which is not a zero. An agent DOES leave a dispatch
  // record by construction, so its n/a means the ledger holding those launches
  // could not be read — a different sentence from a kind that leaves no record
  // at all.
  if (f === undefined) {
    return `<td class="c-act-col na">not tracked${dev(
      "unmeasured",
      item.kind === "agent"
        ? "Agent launches ARE recorded, so no dispatch record reaching this row means the ledger could not be read for this scan — never a zero."
        : "This kind leaves no dispatch record in local transcripts, so its use cannot be counted either way."
    )}</td>`;
  }

  // A tracked zero. "never used" is the plain phrasing the zero case earns;
  // the age beside it is what makes it actionable, and it is the fact the row
  // used to state twice in two columns.
  if (f === null) {
    const p = item.provenance;
    const age = p ? daysAgo(p.installedAt, win.asOf) : undefined;
    const aged =
      p && age !== undefined
        ? ` <span class="dim">· ${age === 0 ? "new today" : `${fmtInt(age)}d old`}</span>`
        : "";
    const title =
      p && age !== undefined
        ? `${provVerb(p)} ${fmtDay(p.installedAt)}, date from ${PROVENANCE_LABEL[p.source]}.`
        : "";
    return `<td class="c-act-col zero"${title ? ` title="${esc(title)}"` : ""}>never used${aged}${windowMark}</td>`;
  }

  // ONE figure, because the cell answers one question. The two counts are
  // different measurements over different spans and neither is the other's
  // subset: the ledger's lifetime reaches back to when tracking began, the
  // window count to the oldest surviving transcript, and on a machine that
  // started tracking last week the window one covers far more. So the cell
  // leads with the larger — both are counts of real recorded fires, so the
  // larger is a true statement under either method — and the title carries
  // both with the method behind each. Leading with lifetime unconditionally
  // printed "0 fires" on rows the transcripts recorded a dozen times.
  const lt = f.lifetime?.invocations;
  const n = lt === undefined ? f.invocations : Math.max(lt, f.invocations);
  const last = f.lifetime?.lastFired ?? f.lastFired;
  const lastPart = last ? ` <span class="dim">· last ${esc(fmtMon(last, win.asOf))}</span>` : "";
  // The count's own breakdown stays on the cell, because it is the ONE thing
  // the figure cannot show: a lifetime count and a window count are different
  // measurements over different spans, and the leading figure is the lifetime.
  const title = f.lifetime
    ? `${fmtInt(f.lifetime.invocations)} lifetime across ${fmtInt(f.lifetime.sessions)} ${noun}${plural(f.lifetime.sessions)}${f.trackedSince ? ` since tracking began ${fmtDay(f.trackedSince)}` : ""} · ${fmtInt(f.invocations)} in the ${win.span || "scanned"} window, a separate pass over this provider's own store.`
    : `${fmtInt(f.invocations)} across ${fmtInt(f.sessions)} ${noun}${plural(f.sessions)}${f.firstFired ? ` · first ${fmtDay(f.firstFired)}` : ""}.`;

  // The four fact badges that used to ride here — never auto-fired,
  // interrupted, tried & dropped, only-in-one-project — moved to the drawer.
  // Each is a DIFFERENT fact from the count beside it rather than a
  // repetition, so none of them was wrong to state; but four of them on one
  // cell pushed the row past the right edge of a real window, and a fact you
  // cannot read because it is clipped is not a fact you have shown anyone.
  // Every one is stated in full, with its own method, in "is it used".
  return `<td class="c-act-col" title="${esc(title)}"><span class="afig">${fmtInt(n)} fire${plural(n)}</span>${lastPart}${trendGlyph(
    f,
    win,
    quietBudgetNote(item, f, win)
  )}${windowMark}</td>`;
}

function row(
  item: UiItem,
  idx: number,
  state: AppState,
  mergedWin: Window,
  maxInjected: number,
  cols: typeof COLS,
  cut?: CutFact
): string {
  // Every figure in this row was counted out of ONE provider's store, so a
  // qualifier in it names that store's window. The merged window describes the
  // transcript scan, and for a cursor rule — counted over a conversation store
  // reaching back a year — it describes nothing this row contains.
  const win = windowFor(mergedWin, item);
  const has = (key: SortKey): boolean => cols.some((c) => c.key === key);
  const cls = [
    item.enabled ? "" : "off",
    cut?.dropped ? "dropped" : "",
    state.selected === item.id ? "sel" : "",
    state.animate ? "settle" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style = state.animate ? ` style="animation-delay:${240 + Math.min(idx, 28) * 14}ms"` : "";
  // The description is what a name like `harden` means — reachable from the
  // row, not only from the drawer. The path rides along underneath it.
  const nameTip = item.description ? `${item.description}\n\n${item.path}` : item.path;
  // Savings if disabled: what this row would stop costing, stated on the
  // control that would do it. Only where the action exists and only where
  // there is something to save — a "−0 tok" affordance would be chrome
  // offering nothing.
  const saving = item.togglable && item.enabled ? tokens(item.injectedChars) : 0;
  const saveBtn =
    saving > 0
      ? `<button class="act save" data-toggle="${item.id}" data-saving-chars="${item.injectedChars}" aria-label="${esc(`disable ${item.name} — stops paying ${fmtInt(saving)} tokens every session`)}" title="${esc(
          `Disable — stops paying ${fmtInt(saving)} tok in every session. The file is moved to ~/.claude/skills-disabled, not deleted, and its fire history is kept.`
        )}">−${fmtInt(saving)} tok</button>`
      : "";
  return `<tr class="${cls}" data-id="${item.id}" tabindex="0"${style}>
    <td class="c-sw">${switchCell(item)}</td>
    <td class="c-name" title="${esc(nameTip)}"><i class="kg kg-${esc(item.kind)}" aria-hidden="true">${KIND_GLYPH[item.kind] ?? ""}</i>${nameCell(item, cut)}</td>
    ${has("source") ? `<td class="dim">${esc(item.source)}</td>` : ""}
    ${has("scope") ? `<td class="dim">${item.scope === "user" ? "user" : "proj"}</td>` : ""}
    ${costCell(item, maxInjected, mergedWin)}
    ${activityCell(item, mergedWin, win)}
    <td>${findingsCell(item)}</td>
    <td class="c-act">${saveBtn}<button class="act" data-open="${item.id}" title="open in editor">edit</button></td>
  </tr>`;
}

function groupRow(
  g: { plugin: string; version: string; marketplace?: string; latest?: string; items: UiItem[] },
  span: number,
  busy?: boolean,
  sup?: UiSuperseded
): string {
  const mp = g.marketplace ? ` · ${esc(g.marketplace)}` : "";
  const off = g.items.every((i) => !i.enabled) ? " · disabled" : "";
  // "newer listed" is a claim about the LOCAL marketplace checkout — honest
  // about staleness, and absent entirely when the version cannot be resolved.
  const newer = g.latest && g.latest !== g.version;
  const upd = newer ? `<span class="upd">${esc(g.latest!)} listed</span>` : "";
  const updBtn = g.marketplace
    ? `<button class="act pupd" data-plugin-update="${esc(g.plugin)}" data-marketplace="${esc(g.marketplace)}"${busy ? " disabled" : ""}
        data-tip="Runs: claude plugin update ${esc(g.plugin)}@${esc(g.marketplace)}${newer ? ` — the local marketplace lists ${esc(g.latest!)}` : ""}. Restart Claude Code afterwards to pick up the new version.">update</button>`
    : "";
  // Versions still on disk that nothing resolves to. Reported with their sizes
  // and paths and never deleted: this tool measures, it does not clean up.
  const superseded =
    sup && sup.versions.length > 0
      ? `<span class="supd" title="${esc(
          `${sup.versions.length} version${plural(sup.versions.length)} of ${sup.plugin} still on disk that nothing resolves to — ${sup.active} is the live one. Reported, never deleted; remove them yourself if you want the space back.\n\n${sup.paths.join("\n")}`
        )}">${fmtInt(sup.versions.length)} superseded on disk · ${esc(sup.versions.join(", "))} · ${esc(fmtBytes(sup.bytes))}</span>`
      : "";
  return `<tr class="grp"><td colspan="${span}"><span class="engr">plugin</span> ${esc(g.plugin)} <span class="ver">${esc(g.version)}</span>${upd}<span class="dim">${mp} · ${g.items.length} item${g.items.length === 1 ? "" : "s"} · read-only${off}</span>${superseded}${updBtn}</td></tr>`;
}

function emptyState(payload: UiPayload): string {
  return `<div class="empty-state">
    <span class="engr">no instruction files found</span>
    <p>context-audit looked for <b>~/.claude</b> (skills, agents, commands, CLAUDE.md, plugins),
    <b>~/.codex</b> (prompts, AGENTS.md), <b>.cursor/rules</b> / <b>.cursorrules</b> and <b>AGENTS.md</b>
    under <b>${esc(payload.root)}</b>.</p>
    <p>If your setup lives elsewhere, point the dashboard at it: <code>context-audit ui &lt;dir&gt;</code>.
    Every number here is measured locally; nothing leaves the machine.</p>
  </div>`;
}

function table(payload: UiPayload, state: AppState): string {
  if (payload.items.length === 0) return emptyState(payload);
  const win = usageWindow(payload);
  const base = navBase(payload, state);
  const cols = activeCols(base);
  const span = cols.length + 1;
  const items = visibleItems(payload, state);
  // Meter scale comes from the WHOLE inventory, not the filtered view — a
  // bar that grows when you filter would be lying about relative cost.
  const maxInjected = Math.max(...payload.items.map((i) => i.injectedChars), 0);
  const { loose, groups } = grouped(items);
  // The listing cut still marks every dropped row inline. The two-line divider
  // that used to sit in the table is gone: it restated the listing view's own
  // headline in the middle of the inventory, and its placement was only ever
  // true for one sort order.
  const cut = cutIndex(payload);
  const supFor = (plugin: string, marketplace?: string): UiSuperseded | undefined =>
    (payload.superseded ?? []).find(
      (s) => s.plugin === plugin && (s.marketplace ?? "") === (marketplace ?? "")
    );
  let idx = 0;
  const looseRows = loose
    .map((i) => row(i, idx++, state, win, maxInjected, cols, cut?.byId.get(i.id)))
    .join("");
  const groupRows = groups
    .map(
      (g) =>
        groupRow(g, span, state.busy, supFor(g.plugin, g.marketplace)) +
        g.items.map((i) => row(i, idx++, state, win, maxInjected, cols, cut?.byId.get(i.id))).join("")
    )
    .join("");
  // Two different empty states: filters that matched nothing (clear them), and
  // a nav entry whose base is empty (the way out is the sidebar, not the
  // filters).
  const none =
    items.length === 0
      ? base.length === 0
        ? `<tr class="nomatch"><td colspan="${span}">nothing in this view — <button class="inlineclear" data-nav="all">show the whole inventory (${fmtInt(payload.items.length)} items)</button></td></tr>`
        : `<tr class="nomatch"><td colspan="${span}">nothing matches this filter — this view has ${fmtInt(base.length)} items. <button class="inlineclear" data-clear>clear filters</button></td></tr>`
      : "";
  return `<table class="inv" aria-label="instruction inventory">
    <thead>${tableHead(state, cols)}</thead>
    <tbody>${looseRows}${groupRows}${none}</tbody>
  </table>`;
}

/**
 * The flagged view's own header: the count, and the instruction that matters
 * more than the count. Rendered above the table rather than as a tooltip on a
 * readout, which is where it used to live and therefore went unread.
 */
function flaggedHead(payload: UiPayload): string {
  const h = payload.header;
  const body =
    h.flagged === 0
      ? `Nothing on this machine carries a security flag. That is a reading of what the checks found, not a guarantee that every file is safe.`
      : `<b>${fmtInt(h.flagged)}</b> item${plural(h.flagged)} carr${h.flagged === 1 ? "ies" : "y"} at least one security flag${h.flaggedHigh > 0 ? `, <b class="dgr">${fmtInt(h.flaggedHigh)}</b> of them critical or high` : ""}. Open a row to read the evidence line, and verify it at the cited file before acting on it.`;
  return `<p class="viewnote">${body}</p>`;
}

// --- drawer ----------------------------------------------------------------

function findingBlock(f: SecurityFinding): string {
  const sev = esc(f.severity);
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  return `<div class="finding ${f.level === "flag" ? sev : "info"}">
    <div class="fhead"><span class="sevplate">${sev}</span><span class="conf">${esc(f.confidence)}</span><span class="check">${esc(f.check)}</span><span class="lvl">${f.level}</span></div>
    <p>${esc(f.message)}</p>
    <pre class="ev">${esc(f.evidence)}</pre>
    <span class="floc" title="${esc(f.path ?? "")}">${esc(loc)}</span>
  </div>`;
}

function kv(label: string, value: string): string {
  return `<div class="kv"><span class="engr">${esc(label)}</span><span>${value}</span></div>`;
}

/**
 * One measured fact on one line: figures in the drawer's numeric face, the
 * qualifier that makes them readable inline, and the method behind them on
 * hover. Denser than a `kv` row on purpose — the ledger adds a dozen facets
 * per item, and a dozen label/value rows would be the wall this drawer is
 * meant not to become. `html` is composed here, never payload text; anything
 * from the payload is escaped by its caller.
 */
function factline(html: string, method = ""): string {
  return `<p class="factline"${method ? ` title="${esc(method)}"` : ""}>${html}</p>`;
}

/**
 * What "always in context" actually consists of, per injection model — the
 * word "injected" is the tool's internal vocabulary and means nothing to a
 * reader looking at the number for the first time.
 */
const INJECTION_NOTE: Record<UiItem["injection"], string> = {
  description:
    "Its name and description ride along in every session so the model can decide when to reach for it. That is the part you pay for constantly.",
  body: "This file is injected whole into every session — the entire body is a permanent cost.",
  "name-only": "Only its name is listed until you invoke it, so it costs almost nothing to keep around.",
  "on-demand": "Nothing is loaded until this triggers — it costs nothing while idle.",
};

/**
 * The trend strip: one discrete cell per ISO week from the first recorded bin
 * through the scan week, missing weeks rendered as explicit empty cells — a
 * gap is a fact, not an absence of markup. Countable on purpose; not a line.
 */
function weekStrip(f: UiFires, w: Window, crossedAt?: string): string {
  const bins = f.weeklyBins;
  if (!bins || bins.length === 0) return "";
  const byWeek = new Map<string, number>();
  for (const b of bins) byWeek.set(b.weekStart.slice(0, 10), b.count);
  const starts = [...byWeek.keys()].sort();
  const first = Date.parse(starts[0]);
  if (Number.isNaN(first)) return "";
  let end = Date.parse(starts[starts.length - 1]);
  if (w.asOf) {
    const t = Date.parse(w.asOf);
    // Extend to the scan week so trailing quiet weeks are visible cells.
    if (!Number.isNaN(t)) end = Math.max(end, t);
  }
  // The budget-crossing tick: the week the snapshot history recorded the
  // skill listing going over budget, outlined so a quiet spell can be read
  // against the event that may explain it. A dated fact, not a verdict.
  const crossed = crossedAt !== undefined ? Date.parse(crossedAt) : NaN;
  const cells: string[] = [];
  for (let t0 = first; t0 <= end; t0 += 7 * DAY) {
    const key = new Date(t0).toISOString().slice(0, 10);
    const n = byWeek.get(key) ?? 0;
    const bucket = n === 0 ? "" : n <= 2 ? " b1" : n <= 5 ? " b2" : " b3";
    const hasTick = !Number.isNaN(crossed) && crossed >= t0 && crossed < t0 + 7 * DAY;
    cells.push(
      `<i class="wk${bucket}${hasTick ? " crossed" : ""}" title="${esc(`week of ${key} — ${fmtInt(n)} fire${n === 1 ? "" : "s"}${hasTick ? ` · skill listing went over budget ${fmtDay(crossedAt)}` : ""}`)}"></i>`
    );
  }
  const shown = cells.length > 104 ? cells.slice(cells.length - 104) : cells;
  const earlier = cells.length - shown.length;
  // The legend names the tick only when the ticked cell is actually visible.
  const ticked = shown.some((c) => c.includes(" crossed"));
  return `<div class="wkstrip" role="img" aria-label="fires per ISO week">${shown.join("")}</div>
    <p class="kv-note">one cell per ISO week, oldest to the scan week${earlier > 0 ? ` · ${fmtInt(earlier)} earlier weeks not shown` : ""} · darker = more fires (1–2, 3–5, 6+)${ticked ? ` · outlined cell = skill listing went over budget` : ""}</p>`;
}

/**
 * The drawer's CONTENTS. Held apart from its container because the container
 * has to outlive a re-render: the 260ms slide is a CSS transition, and a node
 * that is replaced wholesale arrives already-open with nothing to transition
 * from. main.ts keeps one `<aside>` and swaps only what is inside it.
 */
export function renderDrawerBody(
  item: UiItem | undefined,
  state: AppState,
  win?: Window,
  totalSessions = 0
): string {
  if (!item) return "";
  const f = item.fires;
  // The window this row's own figures were counted over — resolved from the
  // merged one the caller threads in, so a cursor rule is qualified by the
  // conversation store it came out of rather than by Claude Code's transcript
  // retention. `usageWindow` carries the per-provider windows for exactly this
  // reason: the drawer is handed a Window and never the payload.
  const w = win ? windowFor(win, item) : { span: "", note: "", none: "no data" };
  const noun = sessionNoun(item);
  // Breadth carries its denominator: "across 3 of 87 sessions (3%)" — the
  // share-of-work fact, both figures from the same transcript window. The
  // denominator is skew-guarded the way tokPerFire's is, and absent (falling
  // back to the bare count) when no transcript total was threaded through, or
  // when the total is not this provider's to divide by: `transcriptFiles`
  // counts Claude transcripts and Codex rollouts, and Cursor CONVERSATIONS
  // over Claude TRANSCRIPTS is a percentage of nothing. A bare count is a fact;
  // that percentage would not be.
  const breadthOf = (u: UiFires): string => {
    const denom = comparableSessions(item) && totalSessions > 0 ? Math.max(totalSessions, u.sessions) : 0;
    return denom > 0
      ? `across <b>${fmtInt(u.sessions)}</b> of <b>${fmtInt(denom)}</b> ${noun}${denom === 1 ? "" : "s"} (${Math.round((u.sessions / denom) * 100)}%)`
      : `across <b>${fmtInt(u.sessions)}</b> ${noun}${u.sessions === 1 ? "" : "s"}`;
  };
  // Why no share is stated, where one is withheld for the reason above — a
  // missing percentage that says nothing reads as an oversight.
  const breadthNote =
    f && f.invocations > 0 && !comparableSessions(item)
      ? `<p class="kv-note">${esc(
          `No share of your ${noun}s is stated: this payload counts transcripts for the other harnesses and carries no ${noun} total for ${item.source}, and dividing one store's ${noun}s by another store's total would be a percentage of nothing.`
        )}</p>`
      : "";
  const fireLine =
    item.twinPath && !item.enabled
      ? `<span class="na">shadowed — fires are recorded by dispatch name, and the enabled copy of this name carries the history</span>`
      : f === undefined
      ? item.kind === "agent"
        ? `<span class="na">n/a — no dispatch record reached this row for this scan. Agent launches ARE recorded, so this is an absent measurement, never a zero.</span>`
        : `<span class="na">n/a — this kind leaves no dispatch record, so its use cannot be counted either way</span>`
      : f === null
        ? `<span class="zero">no fires in the scanned window</span>`
        : `<b>${fmtInt(f.invocations)}</b> invocation${f.invocations === 1 ? "" : "s"} ${breadthOf(f)}` +
          `${f.firstFired ? `<br>first ${fmtDay(f.firstFired)}` : ""}` +
          `${f.lastFired ? ` · last ${fmtDay(f.lastFired)}` : ""}` +
          // The interrupted fact in full: count, the body tokens loaded for
          // runs that did not finish, and the share of fires — window figures
          // on both sides of the division, percentage only when there is one.
          `${
            f.interruptedAfter > 0
              ? ` · interrupted ${fmtInt(f.interruptedAfter)}× (~${fmtInt(tokens(item.bodyChars * f.interruptedAfter))} tok${f.invocations > 0 ? `, ${Math.round((f.interruptedAfter / f.invocations) * 100)}% of fires` : ""})`
              : ""
          }`;
  // The window used to be stated in full, in every drawer, beside every count.
  // It is stated once now, in the provenance statement, and what rides here is
  // only what that statement cannot cover: this row was counted over a
  // DIFFERENT window. A figure the statement describes carries nothing.
  const pageWin = win ?? w;
  const fireCaveat =
    f === undefined || (w.span === pageWin.span && w.start === pageWin.start)
      ? ""
      : `<p class="caveat-note">${esc(w.note)}</p>`;

  // Ledger-backed extras: absent until the ledger join runs, and withheld from
  // a shadowed twin — the enabled copy's row carries the history.
  const fx = item.twinPath && !item.enabled ? undefined : f ?? undefined;

  // Only claude-listed skills are subject to the listing budget, so only they
  // carry its crossing tick and the quiet-onset annotation.
  const listed =
    item.enabled && item.kind === "skill" && (item.source === "claude" || item.source === "custom");
  const budgetNote = fx ? quietBudgetNote(item, fx, w) : "";

  const prov = item.provenance;
  const provAge = prov ? daysAgo(prov.installedAt, w.asOf) : undefined;
  // How long the item sat before it was first reached for. Present only when
  // the install date falls inside tracked history — otherwise the first fire
  // on record is the horizon, and the interval would measure when this tool
  // started looking rather than how long the user took.
  const i2f = fx?.installToFirstFire;
  const provSection = prov
    ? `<div class="dsub">
        <span class="engr sub">first seen</span>
        ${kv(
          prov.source === "mtime" ? "last edited" : "installed",
          `<b>${esc(fmtDay(prov.installedAt))}</b>${provAge !== undefined ? ` · ${fmtInt(provAge)}d ago` : ""}${prov.origin ? ` <span class="dim">· from ${esc(prov.origin)}</span>` : ""}`
        )}
        <p class="kv-note">Date from ${esc(PROVENANCE_LABEL[prov.source])}. Snapshotted at first sighting, because the filesystem evidence behind it decays.</p>
        ${
          i2f !== undefined
            ? factline(
                i2f === 0
                  ? `first fired <b>the same day</b> it arrived`
                  : `sat <b>${fmtInt(i2f)}d</b> before its first recorded fire`,
                "Days from the install date above to the first fire on record. Stated only because that install date falls inside tracked history — for anything installed before tracking began, the first fire on record is the horizon, not the first fire that happened."
              )
            : ""
        }
      </div>`
    : "";

  const lifetimeLine = fx?.lifetime
    ? fx.lifetime.invocations > 0
      ? `<p class="lifeline"><b>${fmtInt(fx.lifetime.invocations)}</b> lifetime invocation${fx.lifetime.invocations === 1 ? "" : "s"} across <b>${fmtInt(fx.lifetime.sessions)}</b> ${noun}${fx.lifetime.sessions === 1 ? "" : "s"}${fx.trackedSince ? ` since tracking began ${fmtDay(fx.trackedSince)}` : " (tracking start date unavailable)"}` +
        `${fx.lifetime.firstFired ? `<br>first ${fmtDay(fx.lifetime.firstFired)}` : ""}${fx.lifetime.lastFired ? ` · last ${fmtDay(fx.lifetime.lastFired)}` : ""}</p>`
      : `<p class="lifeline zero">0 recorded in the durable ledger${fx.trackedSince ? ` since tracking began ${fmtDay(fx.trackedSince)}` : ""} — the window count above comes from transcript lines, a different method.</p>`
    : "";

  const ch = fx?.byChannel;
  const chTotal = ch ? ch.auto + ch.typed : 0;
  const channelBlock =
    ch && chTotal > 0
      ? (() => {
          const pa = Math.round((ch.auto / chTotal) * 100);
          return (
            `<div class="chsplit" title="${esc(`model-dispatched (auto) vs user-typed fires, lifetime${fx!.trackedSince ? ` since ${fmtDay(fx!.trackedSince)}` : ""}`)}">
              <span class="chbar" aria-hidden="true"><i class="ch-auto" style="width:${pa}%"></i><i class="ch-typed" style="width:${100 - pa}%"></i></span>
              <span class="chlab">auto <b>${fmtInt(ch.auto)}</b> · typed <b>${fmtInt(ch.typed)}</b></span>
            </div>` +
            (ch.auto === 0
              ? `<p class="kv-note">never auto-fired — every recorded fire was typed. The model has not reached for this on its own${fx!.trackedSince ? ` since tracking began ${fmtDay(fx!.trackedSince)}` : ""}.</p>`
              : "")
          );
        })()
      : "";

  // Which projects — chips under the breadth count, display names with
  // lifetime counts. The payload already reduced paths to basenames; the
  // qualifier says which window the counts are from.
  const projLine =
    fx?.byProject && fx.byProject.length > 0
      ? `<p class="projline">${fx.byProject.map((p) => `<span class="pchip">${esc(p.name)} <b>${fmtInt(p.count)}</b></span>`).join(" ")} <span class="dim">lifetime fires per project</span></p>`
      : "";

  const provEntries = fx?.byProvider
    ? Object.entries(fx.byProvider)
        .filter((e): e is [string, number] => typeof e[1] === "number")
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    : [];
  // Which providers READ this file — a different fact from who fired it, and
  // stated even (especially) for items with no fires at all: an AGENTS.md is
  // read, not fired, and silence about its readers would hide its one fact.
  const readByLine =
    item.readBy && item.readBy.length > 0
      ? `<p class="provline">read by ${item.readBy.map(esc).join(" · ")}</p>`
      : "";
  const providerLines =
    provEntries.length > 1
      ? `<p class="provline">${provEntries.map(([s, n]) => `${esc(s)} <b>${fmtInt(n)}</b>`).join(" · ")} <span class="dim">lifetime fires per provider</span></p>`
      : "";

  const oc = fx?.outcomes;
  const outcomeLine =
    oc && (oc.error > 0 || oc.rejected > 0)
      ? `<p class="outcomeline" title="${esc(`launch results recorded in the ledger${fx!.trackedSince ? ` since tracking began ${fmtDay(fx!.trackedSince)}` : ""}`)}"><b>${fmtInt(oc.ok + oc.error + oc.rejected)}</b> fires${oc.error > 0 ? ` · <b>${fmtInt(oc.error)}</b> errored` : ""}${oc.rejected > 0 ? ` · <b>${fmtInt(oc.rejected)}</b> rejected` : ""}</p>`
      : "";

  const collisionBlock = item.collision
    ? `<div class="caveat-note">same dispatch name at ${fmtInt(item.collision.paths.length + 1)} paths — fires cannot be split between the copies. The other cop${item.collision.paths.length === 1 ? "y" : "ies"}:
        <ul class="colpaths">${item.collision.paths.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`
    : "";

  // --- fires, the facets the ledger adds ------------------------------------
  // Every one of these is absent rather than zeroed when its evidence is
  // missing, and each states the window or the rhythm it was measured over.

  // "Is it me, or my automation?" An item whose events carry no entrypoint at
  // all cannot answer that — and MOST banked events carry none. Saying "0%
  // automated" there would invent the very split this is asked to measure, so
  // the absence is the answer that renders.
  const ent = fx?.byEntrypoint;
  const entryLine = !ent
    ? ""
    : ent.interactive + ent.automated === 0
      ? `<p class="kv-note">Entrypoint not recorded — not one of this item's ${fmtInt(ent.unknown)} recorded fire${plural(ent.unknown)} carries one, so interactive and automated use cannot be split. A gap in the record, not 0% automated.</p>`
      : factline(
          `interactive <b>${fmtInt(ent.interactive)}</b> · automated <b>${fmtInt(ent.automated)}</b>` +
            (ent.unknown > 0 ? ` · not recorded <b>${fmtInt(ent.unknown)}</b>` : "") +
            ` <span class="dim">by entrypoint</span>`,
          "Interactive is the `cli` entrypoint; automated is `sdk-cli` and its relatives. Events carrying no entrypoint keep their own bucket and are never folded into either."
        );

  // Main conversation vs inside a subagent's own run.
  const ag = fx?.byAgent;
  const agentLine = ag
    ? factline(
        `main <b>${fmtInt(ag.main)}</b> · sidechain <b>${fmtInt(ag.sidechain)}</b> <span class="dim">where it fired</span>`,
        "A sidechain fire happened inside a subagent's run rather than in the main conversation — the count is of this item's own dispatches either way."
      )
    : "";

  const modelLine =
    fx?.byModel && fx.byModel.length > 0
      ? `<p class="projline">${fx.byModel
          .map((m) => `<span class="pchip">${esc(m.model)} <b>${fmtInt(m.count)}</b></span>`)
          .join(" ")} <span class="dim">fires per dispatching model</span></p>`
      : "";

  // The silence, measured against this item's OWN rhythm — 34 quiet days mean
  // nothing until you know its longest previous gap was 12.
  const q = fx?.quiet;
  const quietLine = q
    ? factline(
        `quiet <b>${fmtInt(q.days)}d</b>` +
          (q.longestPriorGapDays !== undefined
            ? ` · longest prior gap <b>${fmtInt(q.longestPriorGapDays)}d</b> <span class="dim">over ${fmtInt(q.gapsCounted)} gap${plural(q.gapsCounted)}</span>`
            : ""),
        "The current silence beside the longest gap between this item's own previous fires, both from the dated ledger events. A gap says nothing until you know its usual rhythm — and this compares it only to itself."
      )
    : "";

  // Staple or one burst: active weeks over the weeks it has existed in the
  // record, both counted in the same ISO weeks the strip above draws.
  const spr = fx?.spread;
  const spreadLine = spr
    ? factline(
        (spr.oneBurst
          ? `one burst — every fire inside ${spr.spanDays === 0 ? "<b>a single day</b>" : `<b>${fmtInt(spr.spanDays)}d</b>`}, `
          : `span <b>${fmtInt(spr.spanDays)}d</b> · `) +
          `active in <b>${fmtInt(spr.activeWeeks)}</b> of ${fmtInt(spr.weeksSinceFirst)} week${plural(spr.weeksSinceFirst)} since its first fire`,
        "Weeks with at least one fire, over the ISO weeks since the first recorded one. A staple recurs across weeks; a one-burst item's fires all landed inside a single 7-day span."
      )
    : "";

  // Either side of the plugin's update boundary, over SYMMETRIC windows — an
  // open-ended "prior" would set a fortnight against a lifetime and call the
  // difference a change the update caused.
  const su = fx?.sinceUpdate;
  const sinceUpdateLine = su
    ? factline(
        // The pair is clamped to what the ledger actually watched, so `days`
        // can be shorter than the update's real age. Printing "since update
        // (10d)" for a boundary 100 days old would read as "the update landed
        // 10 days ago" — the window is stated as a cut, not as the age.
        (() => {
          const age = daysAgo(su.at, w.asOf);
          const cut = age !== undefined && age > su.days;
          return (
            `since update ${cut ? `(latest ${fmtInt(su.days)}d of ${fmtInt(age!)}d)` : `(${fmtInt(su.days)}d)`} <b>${fmtInt(su.since)}</b>` +
            ` · prior ${fmtInt(su.days)}d <b>${fmtInt(su.prior)}</b>`
          );
        })(),
        `Fires either side of ${fmtDay(su.at)}, when this plugin's current version landed. Equal spans on both sides, so the two counts are comparable — a difference is a timing fact, not evidence the update caused it.` +
          (() => {
            const age = daysAgo(su.at, w.asOf);
            return age !== undefined && age > su.days
              ? ` Both spans are cut to ${fmtInt(su.days)} days because the ledger only reaches that far back; the rest of the ${fmtInt(age)} days since the update was never observed.`
              : "";
          })()
      )
    : "";

  // Cursor's figures never render without the qualifier they depend on: an
  // undocumented store, and a date that belongs to the conversation rather
  // than to the attachment it is printed beside. Stated on cursor rows even
  // when there is nothing to count, because that absence needs it too.
  const cursorNote =
    item.source === "cursor"
      ? `<p class="caveat-note">Cursor figures come from an undocumented, unversioned local conversation store, opened read-only — a Cursor update can change its shape at any time. A fire here is a rule ATTACHMENT recorded against a message, dated by its conversation's creation time, so every attachment in one conversation carries the same date. No record says whether the rule changed what the model did.</p>`
      : "";

  // --- cost: what one fire costs --------------------------------------------
  //
  // `tok / fire` stopped being a table column: it is a DERIVED RATIO of two
  // figures the row already carries, and a column restating a division is
  // exactly the crowding this page was rebuilt to remove. It belongs where the
  // cost question is the subject — here, and in the prune view.
  const ratio = tokPerFire(item, totalSessions);
  const perFireBlock = ((): string => {
    if (item.twinPath && !item.enabled || f === undefined) return "";
    if (f && ratio !== undefined) {
      const s = Math.max(totalSessions, f.sessions);
      return (
        kv("per fire", `<b>${fmtInt(ratio)}</b> tok`) +
        `<p class="kv-note">${esc(
          `≈ (${fmtInt(tokens(item.injectedChars))} tok/session × ${fmtInt(s)} scanned ${noun}s + ${fmtInt(tokens(item.bodyChars))} tok body × ${fmtInt(f.invocations)} fires) ÷ ${fmtInt(f.invocations)} fires — window figures on both sides of the division.`
        )}</p>`
      );
    }
    // Nothing to divide by. What WAS paid is still a fact, and it is the one
    // worth reading here — but only where a session count exists that belongs
    // to this row's own store. A cost per fire built from another harness's
    // sessions would be a ratio of two different measurements.
    if (!comparableSessions(item)) {
      return `<p class="kv-note">${esc(
        `No cost per fire is stated: this payload carries no ${noun} total for ${item.source}, and dividing this row's cost by another store's ${noun}s would be a ratio of two different measurements.`
      )}</p>`;
    }
    if (!item.enabled || totalSessions <= 0) return "";
    return (
      kv("paid so far", `<b>${fmtInt(tokens(item.injectedChars * totalSessions))}</b> tok`) +
      `<p class="kv-note">${esc(
        `${fmtInt(tokens(item.injectedChars))} tok × ${fmtInt(totalSessions)} scanned ${noun}s, with ${f === null ? "nothing recorded against it" : `no fires recorded in the ${w.span || "scanned"} window`} — so there is no per-fire cost to state.`
      )}</p>`
    );
  })();

  // --- cost: per-agent run cost ---------------------------------------------
  // Near-exact where per-skill cost never can be, because an agent's work
  // lives in a transcript of its own — and stated only beside the method and
  // the denominator that make the figure readable.
  const ac = item.agentCost;
  const launches = fx ? firesCount(fx) : 0;
  const agentCostBlock = ac
    ? kv(
        "run cost",
        `<b>${fmtInt(ac.totalTokens)}</b> tok total · median <b>${fmtInt(ac.medianTokens)}</b> tok${dev(
          "approx",
          "Tokens processed — input, output, cache creation and cache read — summed from each surviving run's own transcript. A token count, not a bill, and only over the runs whose transcripts are still on disk."
        )}`
      ) +
      `<p class="kv-note">${esc(
        `Total tokens processed (input + output + cache creation + cache read), summed from each run's own subagents/agent-<id>.jsonl — a token count, not a bill. ` +
          // The denominator has to be a real one. A launch count smaller than
          // the priced runs is not a denominator, and "priced 4 of 0" would be
          // worse than saying plainly that this payload carries no count to
          // price them against.
          (launches >= ac.runs
            ? `Priced ${fmtInt(ac.runs)} of ${fmtInt(launches)} recorded launch${launches === 1 ? "" : "es"}: a launch whose subagent transcript is gone is left unpriced rather than counted as a zero-token run.`
            : `Priced ${fmtInt(ac.runs)} run${plural(ac.runs)} — one per surviving subagent transcript. This payload states no launch count to price them against.`)
      )}</p>`
    : item.kind === "agent" && launches > 0
      ? `<p class="kv-note">${esc(
          `Run cost unpriced — none of the ${fmtInt(launches)} recorded launch${launches === 1 ? "" : "es"} still has its own subagents/agent-<id>.jsonl transcript to sum. Unmeasured, which is not the same as zero.`
        )}</p>`
      : "";

  // --- content health --------------------------------------------------------

  // One pair of inputs, read whichever way the age makes legible: a recent
  // edit is "and this much has fired since", an old one is "and this much
  // fired in that span".
  const fr = item.freshness;
  // `firesSince` counts ledger events after the edit date — but the ledger's
  // horizon is usually far more recent than an old edit, so "unchanged 187d ·
  // 41 fires in that span" would credit 41 fires to 187 days that were only
  // watched for the last 40. The count is honest; the SPAN it names is not,
  // unless tracking already covered it. Both inputs are on the payload, so the
  // line says which span the number actually covers.
  const trackedSince = item.fires?.trackedSince;
  const countedFrom = fr && trackedSince && trackedSince > fr.editedAt ? trackedSince : undefined;
  // With no ledger there is no count at all — rendering "0 fires in that span"
  // would report an absent measurement as a measured zero. The signal is the
  // WINDOW's, not the row's: a tracked row that never fired carries no
  // `trackedSince` even on a perfectly healthy store, and reading its absence
  // as a failure told every never-fired row that the ledger was unreadable.
  const firesUnmeasured = !!fr && w.ledgerOk === false;
  // Ledger fine, but this row has no tracking date to name (it never fired, so
  // it has no fires object to carry one). The count is real; the SPAN cannot be
  // claimed, because a fire older than the horizon would also read as zero.
  const spanUnknown = !!fr && !firesUnmeasured && trackedSince === undefined;
  const freshBlock = fr
    ? factline(
        firesUnmeasured
          ? fr.days <= 30
            ? `edited <b>${fmtInt(fr.days)}d</b> ago`
            : `unchanged <b>${fmtInt(fr.days)}d</b>`
          : fr.days <= 30
            ? `edited <b>${fmtInt(fr.days)}d</b> ago · <b>${fmtInt(fr.firesSince)}</b> fire${plural(fr.firesSince)} since`
            : countedFrom
              ? `unchanged <b>${fmtInt(fr.days)}d</b> · <b>${fmtInt(fr.firesSince)}</b> fire${plural(fr.firesSince)} since ${fmtDay(countedFrom)}`
              : spanUnknown
                ? `unchanged <b>${fmtInt(fr.days)}d</b> · <b>${fmtInt(fr.firesSince)}</b> fire${plural(fr.firesSince)} recorded`
                : `unchanged <b>${fmtInt(fr.days)}d</b> · <b>${fmtInt(fr.firesSince)}</b> fire${plural(fr.firesSince)} in that span`
      ) +
      `<p class="kv-note">${esc(
        `Edit dated ${fmtDay(fr.editedAt)}, from ${
          fr.source === "git"
            ? "the last commit that touched this asset"
            : "the newest file modification time under its directory — a last touch on disk, not a commit"
        }.` +
          (firesUnmeasured
            ? ` No fire count is stated: the durable ledger could not be read for this scan, so nothing was counted either way.`
            : countedFrom
              ? ` Fires are counted from ${fmtDay(countedFrom)}, when tracking began — the earlier part of those ${fmtInt(fr.days)} days was never observed.`
              : spanUnknown
                ? ` Nothing is recorded against this item, so the count carries no tracking date — a fire older than the ledger's horizon would read as zero here too.`
                : "")
      )}</p>`
    : "";

  // Referenced paths. Drawer-only, tonal, no badge anywhere: a plan template's
  // `src/recovery.js` and a skill's missing `reference/typography.md` look
  // identical to any static reader, so this is a fact to check at the line —
  // never a defect to alarm about. The method is stated where it is read.
  const rf = item.refs;
  const entryName = item.kind === "skill" ? "SKILL.md" : "the entry file";
  const refLoc = (line: number): string =>
    item.kind === "skill" ? `SKILL.md:${fmtInt(line)}` : `line ${fmtInt(line)}`;
  const refBlock =
    rf && rf.checked > 0
      ? factline(
          `<b>${fmtInt(rf.checked)}</b> referenced path${plural(rf.checked)} checked · <b>${fmtInt(rf.missing.length)}</b> did not resolve` +
            (rf.notExecutable.length > 0
              ? ` · <b>${fmtInt(rf.notExecutable.length)}</b> without an exec bit`
              : "")
        ) +
        (rf.missing.length > 0
          ? `<ul class="pathlist">${rf.missing
              .map(
                (m) =>
                  `<li><span class="refpath">${esc(m.path)}</span> <span class="dim">${esc(refLoc(m.line))}</span></li>`
              )
              .join("")}</ul>`
          : "") +
        (rf.notExecutable.length > 0
          ? `<ul class="pathlist">${rf.notExecutable
              .map(
                (n) =>
                  `<li>${esc(n.path)} <span class="dim">${esc(refLoc(n.line))} · has a shebang, no exec bit</span></li>`
              )
              .join("")}</ul>`
          : "") +
        (rf.missing.length > 0 || rf.notExecutable.length > 0
          ? `<p class="kv-note">${esc(
              `Method: paths named in ${entryName}, resolved against the ${item.kind === "skill" ? "skill" : "asset"} directory — a path an example tells you to create reads exactly the same way as one that should already be there. Something to check at the line, not a defect.`
            )}</p>`
          : "")
      : "";

  // Do the bundled references actually get read when it runs? `ofFires` is the
  // denominator, and it can be 0 — the file was read in sessions where this
  // item never fired. That case is stated in words; a 0% would report it as a
  // measured share of something that was never measured.
  const bf = item.bundledFiles;
  const bundledBlock =
    bf && bf.length > 0
      ? (() => {
          const shown = bf.slice(0, 8);
          const lines = shown
            .map((b) => {
              const measured = b.ofFires > 0;
              const pct = measured ? Math.round((b.readInFires / b.ofFires) * 100) : 0;
              const bar = measured
                ? `<span class="share" aria-hidden="true"><i style="width:${pct}%"></i></span>`
                : "";
              const read = measured
                ? `<b>${fmtInt(b.readInFires)}</b> of ${fmtInt(b.ofFires)} fire session${plural(b.ofFires)}`
                : `read, but never during a fire`;
              const method = measured
                ? `${fmtInt(b.readInFires)} of the ${fmtInt(b.ofFires)} session${plural(b.ofFires)} this item fired in recorded a Read of ${b.relPath}`
                : `${b.relPath} was read inside the transcript window, but this item recorded no fire session in that window — the read happened in sessions where it never fired. There is no share to take.`;
              return `<p class="factline bfline" title="${esc(method)}">${bar}<span class="bfpath">${esc(b.relPath)}</span> <span class="dim">${read}</span></p>`;
            })
            .join("");
          const rest = bf.length - shown.length;
          return (
            lines +
            (rest > 0
              ? `<p class="kv-note">${fmtInt(rest)} further bundled file${plural(rest)} was read and is not listed.</p>`
              : "") +
            `<p class="kv-note">Read tool calls that landed inside this item's own directory, counted over the sessions it fired in. Both sides of that share come from the transcript window, not the ledger's lifetime.</p>`
          );
        })()
      : "";

  const healthSection =
    freshBlock || refBlock || bundledBlock
      ? `<div class="dsub"><span class="engr sub">content health</span>${freshBlock}${refBlock}${bundledBlock}</div>`
      : "";

  // --- relationships ---------------------------------------------------------

  const cf = item.confusable;
  const confusableBlock =
    cf && cf.length > 0
      ? `<p class="projline">${cf
          .map((c) => `<span class="pchip">${esc(c.name)} <b>${fmtInt(c.fires)}</b></span>`)
          .join(" ")} <span class="dim">identical description · fires each</span></p>` +
        `<p class="kv-note">${esc(
          `${cf.length === 1 ? "One other item carries" : `${fmtInt(cf.length)} other items carry`} a byte-identical description after whitespace folding, so nothing but the name separates them at dispatch.` +
            (item.coFiredSessions !== undefined
              ? item.coFiredSessions > 0
                ? ` Both fired in ${fmtInt(item.coFiredSessions)} of the same session${plural(item.coFiredSessions)}.`
                : ` No recorded session fired this one and a twin together.`
              : "")
        )}</p>`
      : "";

  const xp = item.crossProvider;
  const crossBlock =
    xp && xp.length > 0
      ? xp
          .map((x) =>
            factline(
              `also under <b>${esc(x.source)}</b> as ${esc(x.name)} <span class="dim">· ${x.identical ? "byte-identical body" : "a different body"}</span>`,
              x.identical
                ? "The two files' bodies hash the same — one asset kept in two places, and paid for under both harnesses."
                : "The same dispatch name under another provider, carrying a body that differs — two things answering to one name."
            )
          )
          .join("")
      : "";

  const nm = item.nearMiss;
  const nearMissBlock =
    nm && nm.length > 0
      ? `<p class="projline">${nm
          .map((n) => `<span class="pchip">${esc(n.name)} <b>${fmtInt(n.count)}</b></span>`)
          .join(" ")} <span class="dim">fired, matched nothing installed</span></p>` +
        `<p class="kv-note">Dispatch names within a short edit distance of this one, or sharing its prefix, that fired and resolved to nothing. The count is how many times.</p>`
      : "";

  const sn = item.scopeNote;
  const scopeBlock = sn
    ? (sn.allFiresIn
        ? factline(
            `every recorded fire landed in one project <span class="dim">·</span> <b>${esc(sn.allFiresIn)}</b>`,
            `This item is ${item.scope}-scoped: its always-in-context cost is paid in every session in every project, while its recorded use is in that one.`
          )
        : "") +
      (sn.alsoAtScope
        ? factline(
            `the same dispatch name also exists at <b>${esc(sn.alsoAtScope)}</b> scope`,
            "Two copies of one name at different scopes. Which one answers depends on where you are, and the fire record cannot say which copy served a given dispatch."
          )
        : "")
    : "";

  const relSection =
    confusableBlock || crossBlock || nearMissBlock || scopeBlock || collisionBlock
      ? `${confusableBlock}${crossBlock}${nearMissBlock}${scopeBlock}${collisionBlock}`
      : "";

  // --- plugin ----------------------------------------------------------------

  const pl = item.plugin;
  const plInstalledAge = pl?.installedAt ? daysAgo(pl.installedAt, w.asOf) : undefined;
  const plUpdatedAge = pl?.lastUpdated ? daysAgo(pl.lastUpdated, w.asOf) : undefined;
  const ur = item.updateRelevance;
  // Absent updateRelevance is UNKNOWN — nothing newer is cached to compare
  // against — and the only place that unknown is worth printing is where a
  // newer version is actually listed, which is where the question gets asked.
  const updateRelevanceBlock = ur
    ? factline(
        ur.identical
          ? `updating to the cached <b>${esc(ur.version)}</b> would leave this item byte-identical`
          : `the cached <b>${esc(ur.version)}</b> differs${ur.changedFiles !== undefined ? ` in <b>${fmtInt(ur.changedFiles)}</b> file${plural(ur.changedFiles)}` : ""} of this item`,
        "A byte comparison against the newest version of this plugin still in the local cache — file contents, not version numbers."
      )
    : pl?.latest && pl.latest !== pl.version
      ? `<p class="kv-note">${esc(
          `Would updating change this item? Unknown — ${pl.latest} is listed by the local marketplace but is not cached on this machine, so there is nothing to compare its files against. Unknown is not "unchanged".`
        )}</p>`
      : "";
  const pluginSection = pl
    ? `<div class="dsub">
        <span class="engr sub">plugin</span>
        ${kv(
          "plugin",
          `${esc(pl.name)} <span class="ver">${esc(pl.version)}</span>` +
            `${pl.latest && pl.latest !== pl.version ? ` <span class="upd">${esc(pl.latest)} listed</span>` : ""}` +
            `${pl.marketplace ? ` <span class="dim">· ${esc(pl.marketplace)}</span>` : ""}`
        )}
        ${
          pl.installedAt
            ? factline(
                `plugin installed <b>${esc(fmtDay(pl.installedAt))}</b>${plInstalledAge !== undefined ? ` <span class="dim">· ${fmtInt(plInstalledAge)}d ago</span>` : ""}`,
                "The plugin manifest's own install record — when this plugin first arrived on the machine, not when this version did."
              )
            : ""
        }
        ${
          pl.lastUpdated
            ? factline(
                `current version since <b>${esc(fmtDay(pl.lastUpdated))}</b>${plUpdatedAge !== undefined ? ` <span class="dim">· ${fmtInt(plUpdatedAge)}d ago</span>` : ""}`,
                "The manifest's lastUpdated: when THIS version landed, not an install date. It is the boundary the fires above are counted either side of."
              )
            : ""
        }
        ${updateRelevanceBlock}
      </div>`
    : "";

  // --- since disabling -------------------------------------------------------
  // There is no disable log. The date below is evidence of a kind, and it is
  // labeled as the kind it is.
  const ds = item.disabledSafety;
  const disabledSection = ds
    ? `<div class="dsub">
        <span class="engr sub">since disabling</span>
        ${
          ds.disabledAt
            ? factline(
                `off since <b>${esc(fmtDay(ds.disabledAt))}</b> or earlier${ds.days !== undefined ? ` <span class="dim">· at least ${fmtInt(ds.days)}d</span>` : ""}${
                  ds.disabledAtSource === "ctime"
                    ? dev(
                        "bound",
                        "Nothing logs a disable. That date is the directory's ctime: moving a skill into skills-disabled is a rename, which leaves mtime alone but bumps ctime — and so does anything else that touches the directory's metadata. The real date is that one or earlier, and the count below is counted only from it."
                      )
                    : ""
                }`
              )
            : ""
        }
        ${factline(
          ds.attemptsSince > 0
            ? `<b>${fmtInt(ds.attemptsSince)}</b> attempted invocation${plural(ds.attemptsSince)} of this name since`
            : `no attempted invocation of this name since`,
          "Fires recorded against this dispatch name after that date. While the name resolves to nothing, an attempt is something that went looking and found it gone."
        )}
        ${
          ds.referencedBy.length > 0
            ? factline(
                `named in the body of <b>${fmtInt(ds.referencedBy.length)}</b> other item${plural(ds.referencedBy.length)}`,
                "Those assets still point at this name. Disabling it does not update them."
              ) + `<ul class="pathlist">${ds.referencedBy.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
            : ""
        }
      </div>`
    : "";

  const evSection =
    fx?.events && fx.events.length > 0
      ? (() => {
          const evs = fx.events!;
          const total = fx.lifetime?.invocations;
          const cap =
            total !== undefined && total > evs.length
              ? `latest ${fmtInt(evs.length)} of ${fmtInt(total)} recorded`
              : `${fmtInt(evs.length)} recorded`;
          const rows = evs
            .map((ev) => {
              // Purged either at scan time (the payload says so) or since —
              // discovered by a 410 on an open attempt this session.
              const purged = !!ev.purged || (state.purgedEvents?.includes(ev.id) ?? false);
              const marks =
                (ev.outcome === "error" ? `<span class="evmark">error</span>` : "") +
                (ev.outcome === "rejected" ? `<span class="evmark">rejected</span>` : "") +
                (ev.interrupted ? `<span class="evmark">interrupted</span>` : "") +
                // Imported rather than observed — one of the six deviations, so
                // it takes the page's one mark rather than a word of its own.
                // Its open affordance still says what it actually opens.
                (ev.backfill
                  ? dev(
                      "backfilled",
                      "Imported from ~/.claude/history.jsonl rather than observed as it happened: no transcript ever sat behind this entry, and only the typed channel reaches back this far."
                    )
                  : "");
              const openTitle = purged
                ? "transcript deleted (event retained)"
                : ev.backfill
                  ? "open history.jsonl at this imported entry"
                  : "open the transcript at this invocation";
              return `<button class="evrow" data-open-event="${esc(ev.id)}" data-event-item="${item.id}"${purged ? " disabled" : ""} title="${esc(openTitle)}">
                <span class="evts">${esc(fmtDay(ev.ts))}</span>
                <span class="evproj">${esc(ev.project)}</span>
                <span class="evch">${esc(ev.channel)}</span>${marks}${purged ? `<span class="evgone">transcript deleted (event retained)</span>` : ""}
              </button>`;
            })
            .join("");
          // With imported rows in the list the caption hedges to "source
          // record" — a backfilled row opens history.jsonl, not a transcript.
          const opens = evs.some((ev) => ev.backfill)
            ? "each row opens its source record at the line"
            : "each row opens its transcript at the line";
          return `<div class="dsub">
            <span class="engr sub">invocations</span>
            <p class="evcap dim">${cap} · newest first${fx.trackedSince ? ` · tracked since ${fmtDay(fx.trackedSince)}` : ""} · ${opens}</p>
            <div class="evlist">${rows}</div>
          </div>`;
        })()
      : "";

  // What the file DECLARES, minus the fields already rendered above it: the
  // name is the drawer's title and the description is the paragraph directly
  // over this table, and reprinting both put the same sentence on screen twice
  // in a row. Everything else is a fact only this block carries.
  const fmRows = Object.entries(item.frontmatter ?? {}).filter(
    ([k, v]) => !(k === "name" && v === item.name) && !(k === "description" && v === item.description)
  );
  const fm =
    fmRows.length > 0
      ? `<div class="dsub"><span class="engr sub">frontmatter</span><table class="fmt">${fmRows
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
          .join("")}</table></div>`
      : "";

  // Flags are the reason this section exists — they render in full, always.
  // Info-level notes are context, and a data-heavy skill can carry dozens of
  // them (one external-url note per bundled file); folded behind a count they
  // inform without burying the drawer.
  const flagFindings = item.findings.filter((f) => f.level === "flag");
  const infoFindings = item.findings.filter((f) => f.level !== "flag");
  const infoBlock =
    infoFindings.length > 3
      ? `<details class="infofold"><summary>${fmtInt(infoFindings.length)} informational notes — context, not flags</summary>${infoFindings.map(findingBlock).join("")}</details>`
      : infoFindings.map(findingBlock).join("");
  const findings =
    item.findings.length > 0
      ? `${flagFindings.map(findingBlock).join("")}${infoBlock}`
      : `<p class="dim">none for this item</p>`;

  const toggleBtn = item.togglable
    ? `<button class="btn" data-toggle="${item.id}"${state.busy ? " disabled" : ""}>${item.enabled ? "disable" : "enable"}</button>`
    : `<span class="ro-note">${esc(item.readOnlyReason ?? "read-only")}</span>`;

  const error = state.error ? `<div class="err" role="alert">${esc(state.error)}</div>` : "";
  return `<div class="dhead">
      <span class="dname">${esc(item.name)}</span>
      <button class="x" data-close title="close (esc)" aria-label="close">×</button>
    </div>
    <div class="dmeta">${esc(item.source)} · ${esc(item.kind)} · ${item.scope === "user" ? "user" : "project"} scope${item.enabled ? "" : " · disabled"}${item.parseError ? ` · <span class="warn-t">couldn’t parse</span>` : ""}</div>
    ${error}
    <div class="dbody">
      <section>
        <span class="engr">what it is</span>
        <p>${item.description ? esc(item.description) : `<span class="dim">none declared</span>`}</p>
        <button class="path" data-open="${item.id}" title="open in editor">${esc(item.path)}</button>
        ${
          item.twinPath
            ? `<p class="caveat-note">${
                item.enabled
                  ? `A second copy of this dispatch name sits disabled at ${esc(item.twinPath)}. Toggling is blocked while both exist — remove or rename one copy first.`
                  : `Shadowed: an enabled copy of this dispatch name exists at ${esc(item.twinPath)}. While it does, this copy never dispatches, and toggling is blocked — remove or rename one copy first.`
              }</p>`
            : ""
        }
        ${fm}
      </section>
      <section>
        <span class="engr">what it costs</span>
        ${kv(
          "always in context",
          `<b>${fmtInt(tokens(item.injectedChars))}</b> tok ≈ ${fmtInt(item.injectedChars)} chars${item.enabled ? "" : " <span class='dim'>(if re-enabled)</span>"}`
        )}
        <p class="kv-note">${esc(INJECTION_NOTE[item.injection])}</p>
        ${kv("only when it runs", `<b>${fmtInt(tokens(item.bodyChars))}</b> tok ≈ ${fmtInt(item.bodyChars)} chars`)}
        <p class="kv-note">The rest of the file. Loaded only after this item is actually invoked, so it costs nothing on a session that never uses it.</p>
        ${perFireBlock}
        ${agentCostBlock}
      </section>
      <section>
        <span class="engr">is it used</span>
        <p>${fireLine}</p>
        ${breadthNote}
        ${lifetimeLine}
        ${projLine}
        ${channelBlock}
        ${entryLine}
        ${agentLine}
        ${modelLine}
        ${readByLine}
        ${providerLines}
        ${outcomeLine}
        ${quietLine}
        ${spreadLine}
        ${sinceUpdateLine}
        ${fx ? weekStrip(fx, w, listed ? w.listingCrossedAt : undefined) : ""}
        ${budgetNote ? `<p class="kv-note">${esc(budgetNote)}</p>` : ""}
        ${cursorNote}
        ${fireCaveat}
        ${evSection}
      </section>
      ${
        provSection || pluginSection || disabledSection
          ? `<section><span class="engr">where it came from</span>${provSection}${pluginSection}${disabledSection}</section>`
          : ""
      }
      ${healthSection ? `<section><span class="engr">is it healthy</span>${healthSection}</section>` : ""}
      ${relSection ? `<section><span class="engr">what else answers to this name</span>${relSection}</section>` : ""}
      <section><span class="engr">is it flagged</span>${findings}</section>
    </div>
    <div class="dact">
      <button class="btn" data-open="${item.id}">open in editor</button>
      ${toggleBtn}
    </div>`;
}

/** The drawer as a standalone element — used by renderApp and static export. */
export function renderDrawer(
  item: UiItem | undefined,
  state: AppState,
  win?: Window,
  totalSessions = 0
): string {
  if (!item) return `<aside class="drawer" aria-hidden="true"></aside>`;
  return `<aside class="drawer open" role="dialog" aria-label="${esc(item.name)}" tabindex="-1">${renderDrawerBody(item, state, win, totalSessions)}</aside>`;
}

// --- page ------------------------------------------------------------------

/**
 * Everything except the drawer, which main.ts keeps as a persistent node.
 *
 * Navigation moved left because the crowding was structural: masthead, readout
 * strip, portfolio strip, filter rail and panel bar were five stacked bands,
 * each spending vertical space the table needed, and trimming their padding
 * was whack-a-mole. A sidebar spends horizontal space the table does not want
 * and removes the competition entirely.
 */
export function renderPage(payload: UiPayload, state: AppState): string {
  return `
  <div class="shell">
    ${sidebar(payload, state)}
    <main class="content">
      <div class="gratbox">${graticule()}${state.animate && state.sweep ? `<div class="sweep"></div>` : ""}</div>
      ${statBar(payload, state)}
      ${viewBar(payload, state)}
      ${provenanceBlock(payload, state)}
      <div id="results">${renderResults(payload, state)}</div>
    </main>
  </div>`;
}

/**
 * The part that changes when a filter changes. Held separate so typing in the
 * search box re-renders the rows WITHOUT touching the field the caret is in.
 */
/**
 * The on-page activity log: everything the server prints to its terminal —
 * toggles, rescans, plugin updates with the CLI's own output — visible where
 * the action happened. Collapsed it is a one-line strip showing the latest
 * entry; open it is a scrollback. All content is escaped: CLI output is text
 * from an external process, not markup.
 */
function logPanel(state: AppState): string {
  if (state.log.length === 0) return "";
  const last = state.log[state.log.length - 1];
  const line = (e: LogEntry): string =>
    `<span class="ll ll-${e.kind}"><i>${esc(e.at)}</i>${e.kind === "cmd" ? "$ " : ""}${esc(e.text)}</span>`;
  return `<div class="logbox">
    <button class="loghead" data-logtoggle aria-expanded="${!!state.logOpen}">
      <span class="engr">activity · ${fmtInt(state.log.length)}</span>
      ${state.logOpen ? "" : `<span class="loglast ll-${last.kind}">${esc(last.text)}</span>`}
      <s aria-hidden="true">${state.logOpen ? "▾" : "▴"}</s>
    </button>
    ${state.logOpen ? `<div class="loglines" data-loglines>${state.log.map(line).join("")}</div>` : ""}
  </div>`;
}

export function renderResults(payload: UiPayload, state: AppState): string {
  const shown = payload.items.length === 0 ? 0 : visibleItems(payload, state).length;
  // The denominator is what this NAV ENTRY could show, and the footer names it
  // so "54" under `skills` never reads as the whole machine.
  const base = navBase(payload, state).length;
  // An empty inventory has nothing to read four ways: the onboarding empty
  // state is the whole answer.
  const key = payload.items.length === 0 ? "all" : navKey(payload, state);
  const analysis = ANALYSIS_KEYS.includes(key);
  const noun = key === "all" || analysis || key === "flagged" ? "items" : KIND_LABEL[key];
  // Nothing flagged is a real reading and the sentence is the whole answer —
  // an empty table with column headings under it would be five labels over a
  // blank room, which is the same failure as an axis drawn over no data.
  const emptySecurity = key === "flagged" && payload.header.flagged === 0;
  const body = analysis
    ? // Per-provider windows ride through so the overlap matrix captions each
      // column with the retention horizon that column was measured over — one
      // shared date would claim a window two of the three providers never had.
      renderPanel(key, payload, state, payload.providerWindows)
    : emptySecurity
      ? `${flaggedHead(payload)}<div class="tablebox"></div>`
      : `${key === "flagged" ? flaggedHead(payload) : ""}<div class="tablebox">${table(payload, state)}</div>`;
  // Dead weight is defined in the terms strip above the table; what the footer
  // adds is which mark carries it, stated only where a marked row is on screen.
  const win = usageWindow(payload);
  const maxInjected = Math.max(...payload.items.map((i) => i.injectedChars), 0);
  const anyDead =
    !analysis && visibleItems(payload, state).some((i) => isDeadWeight(i, maxInjected, win));
  return `${body}
  ${logPanel(state)}
  <div class="foot">
    <span class="live"><i></i>127.0.0.1 — local only, nothing leaves the machine</span>
    ${analysis ? "" : `<span>${fmtInt(shown)} / ${fmtInt(base)} ${esc(noun)} shown</span>`}
    ${anyDead ? `<span class="footdw">amber = <em>dead weight</em>, a cost paid with nothing recorded against it</span>` : ""}
    ${state.error && !state.selected ? `<span class="footerr" role="alert">${esc(state.error)}</span>` : ""}
    <span class="dim">${esc(payload.root)}</span>
  </div>`;
}

/**
 * The whole page as one string, drawer included. main.ts does not use this —
 * it renders the page and the drawer body separately so the drawer node
 * survives — but the smoke test and a future static export both want the
 * complete document from one pure call.
 */
export function renderApp(payload: UiPayload, state: AppState): string {
  const selected = payload.items.find((i) => i.id === state.selected);
  return `${renderPage(payload, state)}
  ${renderDrawer(selected, state, usageWindow(payload), payload.history?.transcriptFiles ?? 0)}
  ${selected ? `<div class="catch" data-close></div>` : ""}`;
}
