// Pure string rendering — no DOM APIs anywhere in this file. That is a load-
// bearing constraint, not a style choice: the frontend smoke test imports this
// module into Node and renders fixture payloads without a browser rig.
import type {
  ListingBudget,
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
import { PANELS, renderPanel } from "./views.js";

export type SortKey =
  | "name"
  | "source"
  | "kind"
  | "scope"
  | "injected"
  | "fires"
  | "tokPerFire"
  | "lastFired"
  | "findings"
  | "state";

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
   * Master scope, not a filter: the skills layer alone, or the whole
   * inventory. Sits outside isFiltered/clear/esc on purpose — clearing your
   * filters should not silently widen what kind of thing you are looking at.
   */
  mode: "skills" | "all";
  /**
   * Which analysis surface the results region is showing — the inventory table
   * (the default; nobody should have to click back to the thing the tool is
   * for) or one of the panels in `PANELS`.
   *
   * Deliberately NOT called a view: the rail's "view" bank is already the lens
   * filter, and one word covering two axes is how a scope gets mistaken for a
   * filter. A panel is not a filter either — it never changes which items are
   * in play, only which reading of them is drawn — so it sits outside
   * isFiltered/clear/esc, exactly like `mode`.
   */
  panel: string;
  /**
   * An explicit id set the table is narrowed to: what a quadrant click and the
   * portfolio strip's proof links produce. It carries its own label because it
   * is rendered as a chip in the rail — a filter with nothing on screen to
   * turn off is the one thing the rail must never hold.
   */
  focus?: { label: string; ids: string[] };
  /** Activity log lines, oldest first; the panel renders only when non-empty. */
  log: LogEntry[];
  logOpen?: boolean;
  /** Active provider filters; empty means all. */
  providers: string[];
  kinds: string[];
  /** Free-text match over name, description and path. */
  query: string;
  lens: "all" | "fired" | "never-fired" | "enabled" | "disabled" | "flagged";
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
    mode: "all",
    panel: "inventory",
    log: [],
    providers: [],
    kinds: [],
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
 * so they are the default view; everything else sits one click away behind
 * the mode control. A payload with no skills at all (a Codex-only or
 * Cursor-only machine) boots to the full inventory instead of an empty table.
 */
export function initialState(payload: UiPayload): AppState {
  const s = defaultState();
  if (payload.items.some((i) => i.kind === "skill")) s.mode = "skills";
  return s;
}

/** Any filter narrowing the table, which is what a "clear" control acts on. */
export const isFiltered = (s: AppState): boolean =>
  s.providers.length > 0 ||
  s.kinds.length > 0 ||
  s.lens !== "all" ||
  s.query.trim() !== "" ||
  (s.focus?.ids.length ?? 0) > 0;

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
const matchKinds = (i: UiItem, kinds: string[]): boolean =>
  kinds.length === 0 || kinds.includes(i.kind);
const matchLens = (i: UiItem, lens: AppState["lens"]): boolean => {
  switch (lens) {
    case "never-fired":
      return i.fires === null;
    case "fired":
      return !!i.fires;
    case "enabled":
      return i.enabled;
    case "disabled":
      return !i.enabled;
    case "flagged":
      return flagCount(i) > 0;
    default:
      return true;
  }
};

/** What the current mode can show at all — the base every filter works within. */
export function modeBase(payload: UiPayload, state: AppState): UiItem[] {
  return state.mode === "skills" ? payload.items.filter((i) => i.kind === "skill") : payload.items;
}

/**
 * The pinned id set, as a Set for the row loops. Undefined when nothing is
 * pinned — every caller then skips the test entirely rather than testing
 * against an empty set that would hide the whole inventory.
 */
const focusIds = (state: AppState): Set<string> | undefined =>
  state.focus && state.focus.ids.length > 0 ? new Set(state.focus.ids) : undefined;

/**
 * A portfolio stat's proof view, resolved to ids that actually exist in this
 * payload. Held here rather than in main.ts so the number the strip PRINTS and
 * the set the click SHOWS are computed once: a stat that says "3" and opens 4
 * rows is the kind of small disagreement that costs a page its credibility.
 *
 * `concentration.items` counts DISPATCH KEYS and `.ids` can be longer — one
 * name installed at two scopes is one key and two rows — so the label states
 * the key count and the set carries every row behind it.
 */
export function focusSet(
  payload: UiPayload,
  key: string
): { label: string; ids: string[] } | undefined {
  const p = payload.portfolio;
  if (!p) return undefined;
  const known = new Set(payload.items.map((i) => i.id));
  const keep = (ids: string[]): string[] => [...new Set(ids)].filter((id) => known.has(id));
  const make = (label: string, ids: string[]): { label: string; ids: string[] } | undefined =>
    ids.length > 0 ? { label, ids } : undefined;
  switch (key) {
    case "concentration": {
      const c = p.concentration;
      return c ? make(`top ${fmtInt(c.items)} by fires`, keep(c.ids)) : undefined;
    }
    case "spend":
      return make("top window spend", keep((p.topSpend ?? []).map((s) => s.id)));
    case "flagged":
      return make("flagged · by activity", keep((p.flaggedByActivity ?? []).map((f) => f.id)));
    default:
      return undefined;
  }
}

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
 * Called on every mode change: filters must obey the same rule as the banks
 * that display them. A dimension with one distinct value in the new base has
 * no bank on screen — so it must hold no filter either, or an INVISIBLE
 * active filter empties the table with nothing on screen to turn off. The
 * size>1 guard mirrors the bank-rendering rule exactly: values are pruned to
 * the base only while the bank still exists to show them.
 */
export function pruneFiltersForMode(payload: UiPayload, state: AppState): void {
  const base = modeBase(payload, state);
  const prune = (vals: string[], get: (i: UiItem) => string): string[] => {
    const present = new Set(base.map(get));
    return present.size > 1 ? vals.filter((v) => present.has(v)) : [];
  };
  state.providers = prune(state.providers, (i) => i.source);
  state.kinds = prune(state.kinds, (i) => i.kind);
}

export function visibleItems(payload: UiPayload, state: AppState): UiItem[] {
  const q = state.query.trim().toLowerCase();
  const pinned = focusIds(state);
  return sortItems(
    modeBase(payload, state).filter(
      (i) =>
        (!pinned || pinned.has(i.id)) &&
        matchQuery(i, q) &&
        matchProviders(i, state.providers) &&
        matchKinds(i, state.kinds) &&
        matchLens(i, state.lens)
    ),
    state.sort,
    payload.history?.transcriptFiles ?? 0
  );
}

/**
 * Every chip's faceted count: computed against the items narrowed by all the
 * OTHER dimensions, so a chip's number always predicts exactly what clicking
 * it will show. Exported on its own because the query is one of those
 * dimensions: typing must update the counts WITHOUT rebuilding the rail (the
 * search input is the node the caret lives in), so main.ts patches the count
 * nodes in place from this list.
 */
export function chipCounts(
  payload: UiPayload,
  state: AppState
): { group: string; value: string; count: number }[] {
  // A pinned id set is one more dimension no chip toggles, so it narrows every
  // facet: with a quadrant pinned, "fired 12" must still predict what clicking
  // "fired" shows, which is 12 items INSIDE the pin.
  const pinned = focusIds(state);
  const base = pinned
    ? modeBase(payload, state).filter((i) => pinned.has(i.id))
    : modeBase(payload, state);
  const q = state.query.trim().toLowerCase();
  const forProviders = base.filter(
    (i) => matchQuery(i, q) && matchKinds(i, state.kinds) && matchLens(i, state.lens)
  );
  const forKinds = base.filter(
    (i) => matchQuery(i, q) && matchProviders(i, state.providers) && matchLens(i, state.lens)
  );
  const forLens = base.filter(
    (i) => matchQuery(i, q) && matchProviders(i, state.providers) && matchKinds(i, state.kinds)
  );
  const counts: { group: string; value: string; count: number }[] = [];
  for (const s of [...new Set(base.map((i) => i.source))].sort()) {
    counts.push({ group: "provider", value: s, count: forProviders.filter((i) => i.source === s).length });
  }
  for (const k of [...new Set(base.map((i) => i.kind))].sort()) {
    counts.push({ group: "kind", value: k, count: forKinds.filter((i) => i.kind === k).length });
  }
  counts.push({ group: "lens", value: "fired", count: forLens.filter((i) => !!i.fires).length });
  counts.push({ group: "lens", value: "never-fired", count: forLens.filter((i) => i.fires === null).length });
  counts.push({ group: "lens", value: "enabled", count: forLens.filter((i) => i.enabled).length });
  counts.push({ group: "lens", value: "disabled", count: forLens.filter((i) => !i.enabled).length });
  counts.push({ group: "lens", value: "flagged", count: forLens.filter((i) => flagCount(i) > 0).length });
  return counts;
}

function sortItems(items: UiItem[], sort: AppState["sort"], sessions: number): UiItem[] {
  const key = (i: UiItem): string | number => {
    switch (sort.key) {
      case "name":
        return i.name.toLowerCase();
      case "source":
        return i.source;
      case "kind":
        return i.kind;
      case "scope":
        return i.scope;
      case "injected":
        return i.injectedChars;
      // "n/a — no history for this provider" is not a low fire count; it is
      // the absence of the measurement. It sorts to the BOTTOM either way,
      // so a tracked zero — the row that actually means "never fired" — is
      // never buried under rows the data cannot speak to.
      case "fires":
        // Sort follows the cell's leading figure: lifetime when the ledger
        // join supplied one, the window count otherwise.
        return i.fires === undefined
          ? sort.dir === 1
            ? Number.MAX_SAFE_INTEGER
            : -1
          : i.fires?.lifetime?.invocations ?? i.fires?.invocations ?? 0;
      case "tokPerFire": {
        const r = tokPerFire(i, sessions);
        if (r !== undefined) return r;
        // Nothing to divide by. Tracked-but-fireless rows sort last, and
        // untracked n/a rows after them — in BOTH directions, without ever
        // manufacturing an Infinity or NaN key.
        const rank = i.fires === undefined ? 2 : 1;
        return sort.dir === 1 ? Number.MAX_SAFE_INTEGER - 2 + rank : -rank;
      }
      case "lastFired":
        return i.fires?.lastFired ?? "";
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

function readout(
  label: string,
  value: string,
  unit: string,
  sub: string,
  idx: number,
  animate?: boolean,
  tone = "",
  note = "",
  sub2 = "",
  key = ""
): string {
  const style = animate ? ` style="animation-delay:${180 + idx * 70}ms"` : "";
  const title = note ? ` data-tip="${esc(note)}"` : "";
  // `data-readout` is main.ts's handle on a specific readout — the live
  // what-if total appends a projection line to the always-in-context one while
  // a toggle is being acted on, and finding it by position would break the
  // moment a machine has no skill listing to render.
  const k = key ? ` data-readout="${esc(key)}"` : "";
  return `<div class="readout${animate ? " settle" : ""}${tone}"${style}${title}${k}>
    <span class="engr">${label}${note ? `<b class="why">?</b>` : ""}</span>
    <span class="num">${value}<i>${unit}</i></span>
    <span class="sub">${esc(sub)}</span>
    ${sub2 ? `<span class="sub sub2">${esc(sub2)}</span>` : ""}
  </div>`;
}

function headerReadouts(payload: UiPayload, state: AppState): string {
  const h = payload.header;
  const win = usageWindow(payload);
  const providers = `across ${h.providers} provider${h.providers === 1 ? "" : "s"}`;
  const flaggedSub =
    h.flagged === 0
      ? "none on this machine"
      : `${h.flaggedHigh} critical/high · ${h.flagged - h.flaggedHigh} other`;
  const quietSub =
    h.tracked > 0
      ? `of ${fmtInt(h.tracked)} tracked · ${win.span || "no"} window`
      : "no dispatch-tracked items";
  // Rent is stated per SESSION because that is what the payload's figure is:
  // Σ always-in-context chars over age-gated silent items. Tone unchanged —
  // amber stays reserved for dead-weight cost cells and severity.
  const rent =
    h.deadWeightChars !== undefined && h.deadWeightChars > 0
      ? `~${fmtK(tokens(h.deadWeightChars))} tok/session on silent items`
      : "";
  // What this number CONTAINS, derived from the same rows the engine counted
  // rather than named by hand. S2 made agent launches dispatch-tracked, and on
  // a machine with many agents they are most of this figure — a note listing
  // the kinds from memory went stale the moment that changed, and told the
  // reader the headline excluded exactly the rows making it up.
  const silent = payload.items.filter((i) => i.fires === null);
  const kinds = [...new Set(silent.map((i) => i.kind))]
    .map((k) => ({ kind: k, n: silent.filter((i) => i.kind === k).length }))
    .sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind))
    .map((c) => `${fmtInt(c.n)} ${c.kind}${c.n === 1 ? "" : "s"}`)
    .join(" · ");
  // The headline is the engine's count; the composition is counted here off
  // the same rows. They can only differ on a payload that disagrees with
  // itself — and then BOTH are stated, the way the listing panel does it,
  // rather than one quietly winning.
  const composition =
    kinds === ""
      ? ""
      : silent.length === h.neverFired
        ? `; the ${fmtInt(h.neverFired)} with nothing recorded against them are ${kinds}.`
        : `; the rows with nothing recorded against them are ${kinds} — ${fmtInt(silent.length)} in this payload's item list against the ${fmtInt(h.neverFired)} the headline counted, and both are shown rather than one quietly winning.`;
  // Rows counted over a store of their own: the span in the sub-line is the
  // merged transcript window, and it does not describe them.
  const others = otherWindows(win, payload.items);
  return [
    readout("inventory", fmtInt(h.items), "files", providers, 0, state.animate, "",
      "Every instruction file found: skills, agents, commands, instruction files and plugin assets, enabled or not."),
    readout(
      "always in context",
      fmtInt(h.injectedTokens),
      "tok",
      // "% of a 200K context" is the framing that lands: a raw token count has
      // no scale until it is a slice of the window the model actually has.
      `every session before you type · ≈ ${((h.injectedTokens / 200_000) * 100).toFixed(1)}% of a 200K context`,
      1,
      state.animate,
      "",
      `What your setup costs on every single session, whether or not you use any of it (≈ ${fmtInt(h.injectedChars)} characters). Skills and agents pay their name + description; CLAUDE.md and always-apply rules pay their whole body. Skill bodies are NOT counted here — those load only when the skill runs. Disabled items are excluded.`,
      "",
      "injected"
    ),
    readout(
      "no fires in window",
      fmtInt(h.neverFired),
      "",
      quietSub,
      2,
      state.animate,
      "",
      `${win.note} Counted over the ${fmtInt(h.tracked)} items this machine keeps a dispatch record for` +
        (composition || ".") +
        ` Agents are in that count: the model launches a subagent through the Agent/Task tool and the ledger banks every launch, so a never-launched agent is a measured silence rather than a missing measurement. Instruction files (CLAUDE.md / AGENTS.md) are read rather than dispatched — they leave no dispatch record at all, are not tracked, and are never called unused.` +
        (others ? ` Rows from another store are judged in that store's own window (${others}), not the ${win.span || "merged"} one in the sub-line.` : "") +
        (rent
          ? ` Silent-item rent: the summed always-in-context cost of enabled items that predate their provider's window start yet recorded no fires in it — paid every session either way.`
          : ""),
      rent
    ),
    // The listing budget. Absent on machines it does not apply to (no Claude
    // skills) rather than shown as a zero — a budget nothing is subject to is
    // not a fact about this setup.
    ...(h.listing
      ? [
          readout(
            "skill listing",
            `${fmtInt(h.listing.pct)}%`,
            "",
            h.listing.over
              ? `over the ~${fmtInt(h.listing.budgetChars)}-char budget · descriptions dropped`
              : `of the ~${fmtInt(h.listing.budgetChars)}-char budget · all descriptions load`,
            3,
            state.animate,
            h.listing.over ? " danger" : "",
            (h.listing.over
              ? `Claude Code budgets the skill LISTING — every enabled skill's name and description — in characters (skillListingBudgetFraction, ~1% of the context window). Yours is ${fmtInt(h.listing.chars)} chars, past the ~${fmtInt(h.listing.budgetChars)} budget, so Claude Code is dropping descriptions starting with the skills you invoke least. Those skills still exist; they just stop auto-triggering, which looks exactly like the model ignoring you. Filter to "no fires" to see which go first. Fix it by removing or shortening descriptions, or raise skillListingBudgetFraction.`
              : `Claude Code budgets the skill LISTING — every enabled skill's name and description — in characters (skillListingBudgetFraction, ~1% of the context window). Yours is ${fmtInt(h.listing.chars)} of ~${fmtInt(h.listing.budgetChars)} chars, so every description loads and every skill can still auto-trigger. Past 100%, Claude Code drops them starting with the skills you invoke least.`) +
              ` Counts user, project and plugin skills alike, since Claude Code lists all three. The \`context-audit\` CLI reports the same figure.`
          ),
        ]
      : []),
    readout(
      "flagged",
      fmtInt(h.flagged),
      "",
      flaggedSub,
      4,
      state.animate,
      h.flaggedHigh > 0 ? " danger" : h.flagged > 0 ? " signal" : "",
      "Items carrying at least one security flag. Open the row to read the evidence line and verify it at the cited file before acting."
    ),
  ].join("");
}

/**
 * Signed diff with a real minus sign, never a hyphen — the figures on this
 * page are typeset, and "-1,204" beside "−205 tok" would be two characters
 * doing one job.
 */
const signed = (n: number): string => (n > 0 ? `+${fmtInt(n)}` : n < 0 ? `−${fmtInt(-n)}` : "0");

/** Chars → tokens keeping the sign: a diff of −812 chars is −203 tok, not −204. */
const signedTokens = (chars: number): number => (chars < 0 ? -tokens(-chars) : tokens(chars));

/** The earliest date any row's ledger figures are counted from. */
function trackedSince(payload: UiPayload): string | undefined {
  return payload.items
    .map((i) => i.fires?.trackedSince)
    .filter((t): t is string => typeof t === "string")
    .sort()[0];
}

/**
 * The portfolio rollup: does the whole system earn its rent? It is the
 * header's companion — payload-wide facts that do NOT follow the rail's
 * filters — so it sits with the readouts, above the filter rail, and is drawn
 * as a low annunciator strip rather than a second row of hero numbers.
 *
 * Every stat carries the denominator it was measured against, and each one
 * that a filter can express opens its own pre-filtered proof view.
 */
function portfolioStrip(payload: UiPayload, state: AppState): string {
  const p = payload.portfolio;
  const d = payload.delta;
  if (!p && !d) return "";
  const since = trackedSince(payload);
  const stats: string[] = [];

  // One line per stat, and the METHOD note rides the tooltip rather than a
  // second and third rendered line. Five stats each three lines tall wrapped
  // the strip onto two rows and pushed the table under 36% of the viewport —
  // the header is meant to be an instrument panel, not the page. What stays
  // inline is the denominator ("33 of 119", "84% of every recorded fire"),
  // because a share is unreadable without it; what moves is the explanation of
  // how it was measured, which is exactly what every readout above already
  // keeps in `data-tip`.
  const stat = (fig: string, unit: string, txt: string, note: string, cls = ""): string =>
    `<span class="rstat${cls ? ` ${cls}` : ""}"${note ? ` data-tip="${esc(note)}"` : ""}><span class="rfig">${fig}${unit ? `<i>${esc(unit)}</i>` : ""}</span><span class="rtxt">${esc(txt)}</span></span>`;
  const statLink = (
    focus: string,
    fig: string,
    unit: string,
    txt: string,
    note: string,
    tip: string,
    cls = ""
  ): string =>
    `<button class="rstat rlinked${cls ? ` ${cls}` : ""}" data-focus="${esc(focus)}" data-tip="${esc(note ? `${note}\n\n${tip}` : tip)}"><span class="rfig">${fig}${unit ? `<i>${esc(unit)}</i>` : ""}</span><span class="rtxt">${esc(txt)}</span></button>`;

  if (p && p.sessions > 0) {
    // The denominator is the sessions the LEDGER has seen, which is not every
    // session on the machine — said in the caption, not only in the tooltip,
    // because a share is only readable if its denominator is.
    const pct = Math.round((p.sessionsWithFires / p.sessions) * 100);
    stats.push(
      stat(
        fmtInt(p.sessionsWithFires),
        `of ${fmtInt(p.sessions)}`,
        `sessions used a tracked item · ${fmtInt(pct)}%`,
        `ledger-seen sessions${since ? ` since ${fmtDay(since)}` : ""} — not every session on this machine`
      )
    );
  }

  const conc = p?.concentration;
  const concFocus = focusSet(payload, "concentration");
  if (conc && conc.items > 0) {
    const rows = concFocus?.ids.length ?? 0;
    // `items` counts dispatch names; `ids` can be longer, because one name
    // installed at two scopes is one dispatch key and two rows. The count
    // printed is the key count, always — the row count is stated separately.
    const spread =
      rows > conc.items
        ? `opens ${fmtInt(rows)} rows — one name is installed at two scopes`
        : `fewest names making up ≥80% of fires${since ? ` since ${fmtDay(since)}` : ""}`;
    const tip =
      `The fewest dispatch names whose fires add up to at least 80% of every fire on record${since ? `, counted since tracking began ${fmtDay(since)}` : ""}. ` +
      `Counted per dispatch name — provider + kind + name — because two rows sharing a name hold the same events, and summing rows would count those fires twice. ` +
      `Click to pin ${fmtInt(rows)} row${plural(rows)} in the table.`;
    stats.push(
      concFocus
        ? statLink(
            "concentration",
            fmtInt(conc.items),
            conc.items === 1 ? "name" : "names",
            `account for ${fmtInt(conc.pct)}% of every recorded fire`,
            spread,
            tip
          )
        : stat(
            fmtInt(conc.items),
            conc.items === 1 ? "name" : "names",
            `account for ${fmtInt(conc.pct)}% of every recorded fire`,
            spread
          )
    );
  }

  const spend = (p?.topSpend ?? []).filter((s) => s.chars > 0).slice(0, 3);
  if (spend.length > 0) {
    const known = new Map(payload.items.map((i) => [i.id, i]));
    const method =
      `Always-in-context characters multiplied by the sessions the provider that loads them was observed in — a WINDOW TOTAL over the observed history. ` +
      `The header's silent-item rent is a PER-SESSION figure: different unit, different denominator, never to be read side by side as one number.`;
    const links = spend
      .map((s) => {
        const item = known.get(s.id);
        const fig = `<b>${fmtK(tokens(s.chars))}<i>tok</i></b>`;
        const label = `${esc(s.name)} ${fig}`;
        return item
          ? `<button class="rlink" data-id="${esc(s.id)}" title="${esc(`${s.name} — ≈ ${fmtInt(tokens(s.chars))} tok paid across every observed session of its provider (${fmtInt(s.chars)} chars × observed sessions). Open the row.`)}">${label}</button>`
          : `<span class="rlink">${label}</span>`;
      })
      .join("");
    stats.push(
      `<span class="rstat rspend">
        <button class="rlab" data-focus="spend" data-tip="${esc(
          `chars × that provider's observed sessions — a window total, not the header's per-session figure.\n\n${method} Click to pin these rows in the table.`
        )}">top window spend</button>
        <span class="rlinks">${links}</span>
      </span>`
    );
  }

  const fl = p?.flaggedByActivity ?? [];
  if (fl.length > 0) {
    const top = fl[0];
    // Severity is one of the two things amber is for, and the tone follows the
    // header's flagged readout exactly so the two cannot disagree.
    const tone = payload.header.flaggedHigh > 0 ? " dgr" : " sig";
    const note =
      `${top.name} — ${fmtInt(top.fires)} fire${plural(top.fires)}` +
      (top.lastFired ? ` · last ${fmtDay(top.lastFired)}` : " · none recorded") +
      (top.projects > 0 ? ` · ${fmtInt(top.projects)} project${plural(top.projects)}` : "");
    const tip =
      `Flagged items ordered by recorded activity — a flag on something that runs daily outranks a flag on a dormant file. ` +
      `Fires are this row's own ledger events${since ? ` since tracking began ${fmtDay(since)}` : ""}; a row the ledger cannot speak to counts 0 here and says n/a in its drawer. ` +
      `Click to pin them in the table. Verify every flag at its cited line before acting on it.`;
    const f = focusSet(payload, "flagged");
    stats.push(
      f
        ? statLink("flagged", fmtInt(fl.length), "flagged", "ranked by activity", note, tip, tone.trim())
        : stat(fmtInt(fl.length), "flagged", "ranked by activity", note, tone.trim())
    );
  }

  if (d) {
    const ups = d.pluginsUpdated ?? [];
    // No `from` on disk means the previous version was never recorded. Said in
    // those words: a sentinel in that slot would read as a version number.
    const upText = (u: { name: string; from?: string; to: string }): string =>
      u.from
        ? `${u.name} ${u.from} → ${u.to}`
        : `${u.name} updated to ${u.to} (previous version not recorded)`;
    const shownUps = ups.slice(0, 2).map(upText);
    const restUps = ups.length - shownUps.length;
    const tok = signedTokens(d.injectedChars);
    const quiet = d.items === 0 && d.injectedChars === 0 && ups.length === 0;
    const tip =
      `Measured against the previous scan's snapshot, taken ${fmtStamp(d.since)}. Item and cost diffs are that snapshot's own figures subtracted from this one. ` +
      (ups.length > 0
        ? `Plugin moves come from each plugin manifest's "current version since" date, not from the snapshot — snapshots record no plugin versions, which is why a previous version can be unrecorded.\n\n${ups.map(upText).join("\n")}`
        : `Snapshots record no plugin versions, so a plugin move is read from the manifest's "current version since" date; none moved between these two scans.`);
    const note =
      `${fmtDay(d.since)}` +
      (quiet ? "" : ` · ${signed(tok)} tok/session`) +
      (shownUps.length > 0 ? ` · ${shownUps.join(" · ")}` : "") +
      (restUps > 0 ? ` · +${fmtInt(restUps)} more` : "");
    stats.push(
      `<span class="rstat rdelta" data-tip="${esc(`${note}\n\n${tip}`)}">
        <span class="rfig">${quiet ? "—" : esc(signed(d.items))}<i>${esc(quiet ? "no change" : "items")}</i></span>
        <span class="rtxt">since the previous scan</span>
      </span>`
    );
  }

  if (stats.length === 0) return "";
  const style = state.animate ? ` style="animation-delay:${560}ms"` : "";
  return `<div class="rollup${state.animate ? " settle" : ""}"${style}>
    <span class="engr rollup-lab" data-tip="${esc(
      "Portfolio: one pass over the durable ledger, each figure carrying the denominator it was measured against. These describe the whole machine and do not follow the filters below — the stats that a filter can express open their own pre-filtered view of the table."
    )}">portfolio</span>
    ${stats.join("")}
  </div>`;
}

function chip(
  group: string,
  value: string,
  label: string,
  count: number,
  active: boolean,
  note = ""
): string {
  const title = note ? ` data-tip="${esc(note)}"` : "";
  const empty = count === 0 ? " empty" : "";
  // Label and count live in separate compartments split by a hairline — the
  // two must never read as one string ("agent 133" is not a thing).
  return `<button class="chip${active ? " on" : ""}${empty}" data-chip="${esc(group)}" data-value="${esc(value)}" aria-pressed="${active}"${title}><span>${esc(label)}</span><b>${fmtInt(count)}</b></button>`;
}

/**
 * Filters read as labeled instrument banks rather than one undifferentiated
 * run of chips: without the group labels there was nothing to say that `agent`
 * and `skill` are a kind while `flagged` is a view, and no way back to the full
 * inventory once something was clicked.
 *
 * Every chip count is FACETED: computed against the items narrowed by all the
 * OTHER dimensions, so a chip's number always predicts exactly what clicking
 * it will show. Global counts looked right until one filter was active, then
 * quietly stopped matching the table.
 */
function filterRail(payload: UiPayload, state: AppState): string {
  const base = modeBase(payload, state);
  const win = usageWindow(payload);
  const counts = new Map(chipCounts(payload, state).map((c) => [`${c.group}\0${c.value}`, c.count]));
  const n = (group: string, value: string): number => counts.get(`${group}\0${value}`) ?? 0;

  const bank = (label: string, chips: string, note = ""): string =>
    `<span class="bank"><span class="engr"${note ? ` data-tip="${esc(note)}"` : ""}>${label}</span><span class="chipset">${chips}</span></span>`;

  // The master scope: what layer of the inventory the whole page is looking
  // at. Deliberately not a filter — esc and "clear" never touch it.
  const skillCount = payload.items.filter((i) => i.kind === "skill").length;
  const modes = `<div class="modes" role="group" aria-label="inventory scope">
    <button class="mode-btn${state.mode === "skills" ? " on" : ""}" data-mode="skills" aria-pressed="${state.mode === "skills"}"
      data-tip="Just your skills — the togglable, auto-triggering layer this dashboard manages. Commands, agents, rules and instruction files live under everything."><span>◆ skills</span><b>${fmtInt(skillCount)}</b></button>
    <button class="mode-btn${state.mode === "all" ? " on" : ""}" data-mode="all" aria-pressed="${state.mode === "all"}"
      data-tip="The whole instruction inventory: skills plus commands, agents, rules and instruction files, across every provider found."><span>everything</span><b>${fmtInt(payload.items.length)}</b></button>
  </div>`;

  // Banks list the values present in the MODE BASE (so the vocabulary is
  // stable while filtering) and count within the faceted subset. A bank whose
  // dimension has one value filters nothing — it disappears entirely, which
  // is also what makes the kind bank vanish in skills mode.
  const sourcesInBase = [...new Set(base.map((i) => i.source))].sort();
  const providerBank =
    sourcesInBase.length > 1
      ? bank(
          "provider",
          sourcesInBase
            .map((s) => chip("provider", s, s, n("provider", s), state.providers.includes(s)))
            .join("")
        )
      : "";

  const kindsInBase = [...new Set(base.map((i) => i.kind))].sort();
  const kindBank =
    kindsInBase.length > 1
      ? bank(
          "kind",
          kindsInBase
            .map((k) =>
              chip(
                "kind",
                k,
                `${KIND_GLYPH[k] ?? ""} ${k}`.trim(),
                n("kind", k),
                state.kinds.includes(k),
                KIND_NOTE[k] ?? ""
              )
            )
            .join("")
        )
      : "";

  // Complementary pairs: used/silent, on/off, plus flagged. Single-select —
  // clicking an active chip returns to all. The usage window qualifies the
  // whole bank, so it lives once in the bank label ("view · 42d") instead of
  // being repeated inside chip labels, where it collided with the counts.
  //
  // The span in that label is the merged transcript window; a base holding
  // rows from a store with its own retention is filtered over more than one
  // window, and each chip's note says which.
  const lensOthers = otherWindows(win, base);
  const lensNote = `${win.note}${lensOthers ? ` Rows from another provider's store are counted in that store's own window instead (${lensOthers}), so this bank spans more than the ${win.span || "scanned"} one in its label.` : ""}`;
  const lensBank = bank(
    win.span ? `view · ${win.span}` : "view",
    [
      chip(
        "lens",
        "fired",
        "fired",
        n("lens", "fired"),
        state.lens === "fired",
        `Items with at least one recorded invocation in the window its own provider's store covers. ${lensNote}`
      ),
      chip(
        "lens",
        "never-fired",
        "no fires",
        n("lens", "never-fired"),
        state.lens === "never-fired",
        lensNote
      ),
      chip("lens", "enabled", "active", n("lens", "enabled"), state.lens === "enabled",
        "Items currently live: their always-in-context cost is being paid every session."),
      chip("lens", "disabled", "off", n("lens", "disabled"), state.lens === "disabled",
        "Items sitting in ~/.claude/skills-disabled. They cost nothing until re-enabled."),
      chip("lens", "flagged", "flagged", n("lens", "flagged"), state.lens === "flagged",
        "Items carrying at least one security flag."),
    ].join(""),
    lensNote
  );

  // A pinned id set — a quadrant, or a portfolio stat's proof view. It is a
  // filter like any other, so it takes a bank of its own with the count it
  // will actually show and one click to release it. An id filter with nothing
  // on screen to turn off would be an invisible narrowing, which is the exact
  // failure pruneFiltersForMode exists to prevent.
  const pinned = focusIds(state);
  const focusBank =
    state.focus && pinned
      ? bank(
          "focus",
          `<button class="chip on" data-unfocus aria-pressed="true" data-tip="${esc(
            `${fmtInt(state.focus.ids.length)} row${plural(state.focus.ids.length)} pinned from a panel or a portfolio stat; the count is how many of them this view can show. Click to release the pin — the rest of your filters stay as they are.`
          )}"><span>${esc(state.focus.label)} ✕</span><b>${fmtInt(base.filter((i) => pinned.has(i.id)).length)}</b></button>`
        )
      : "";

  // Security findings are never silently hidden by a presentation default: a
  // flag sitting outside the current mode announces itself, and the announce-
  // ment is the way there.
  const hiddenFlagged =
    payload.items.filter((i) => flagCount(i) > 0).length - base.filter((i) => flagCount(i) > 0).length;
  // tip-r: these sit against the rail's right edge, so their tooltips anchor
  // right or they overflow the viewport and grow a horizontal scrollbar.
  const flaggedElsewhere =
    hiddenFlagged > 0
      ? `<button class="caveat caveat-act tip-r" data-mode="all" data-lens="flagged" data-tip="Flagged items outside the skills view. Click to see them.">▲ ${fmtInt(hiddenFlagged)} flagged outside this view</button>`
      : "";

  // Always present, shown by class. Typing must not rebuild the rail — the
  // search field is the node the caret lives in, and replacing it mid-keystroke
  // is how a search box eats the second character you type.
  const clear = `<button class="clear${isFiltered(state) ? "" : " gone"}" data-clear title="show all ${fmtInt(base.length)} items (esc)">clear</button>`;


  return `<div class="rail">
    ${modes}
    <label class="find">
      <span class="engr">find</span>
      <input type="search" data-search value="${esc(state.query)}" placeholder="name or description"
             spellcheck="false" autocomplete="off" aria-label="filter by name, description or path">
    </label>
    ${providerBank}
    ${kindBank}
    ${lensBank}
    ${focusBank}
    ${panelBank(payload, state)}
    ${clear}
    ${flaggedElsewhere}
  </div>`;
}

/**
 * Qualifiers on the whole page's figures, shown in the masthead plate beside
 * the scan stamp and the window.
 *
 * They sit there rather than in the filter rail for two reasons. They describe
 * the SCAN, not the current filter — the same class of fact as "390
 * transcripts" and the window range already printed next to them. And in the
 * rail they were the widest tail element, pushing the row onto a second line
 * that carried nothing else, which cost the inventory more height than the
 * chips occupy.
 */
function caveatChips(payload: UiPayload): string {
  const out: string[] = [];
  if (payload.pluginResolution === "newest-fallback") {
    out.push(
      `<span class="caveat tip-r" data-tip="installed_plugins.json was missing or unreadable">plugin versions: newest-cached fallback</span>`
    );
  }
  // A broken ledger must degrade loudly: lifetime, provenance and dead-weight
  // are absent from this payload, and the page says so instead of quietly
  // rendering window-only figures as if they were the whole story.
  if (payload.ledgerCaveat) {
    out.push(
      `<span class="caveat tip-r" data-tip="${esc(payload.ledgerCaveat)}">usage ledger unavailable — window figures only</span>`
    );
  }
  // Every other qualifier the payload states about its own figures: a provider
  // store that would not open, unreadable ledger lines, a snapshot append that
  // failed, provenance that could not be resolved. Counted here and read in
  // full on hover rather than printed as a wall of amber prose — but a
  // degraded read is never left silent while the payload carries the sentence.
  const cav = payload.caveats ?? [];
  if (cav.length > 0) {
    out.push(
      `<span class="caveat tip-r" data-tip="${esc(`Qualifiers on the figures on this page:\n\n${cav.join("\n\n")}`)}">${fmtInt(cav.length)} caveat${plural(cav.length)}</span>`
    );
  }
  return out.join("");
}

const COLS: { key: SortKey; label: string; cls?: string; note?: string }[] = [
  { key: "state", label: "state", note: "Enabled or disabled. Only Claude user skills can be toggled here." },
  { key: "name", label: "name", cls: "c-name", note: "The name the harness dispatches on." },
  { key: "source", label: "provider" },
  { key: "kind", label: "kind" },
  { key: "scope", label: "scope", note: "user = your home directory · proj = this project directory" },
  {
    key: "injected",
    label: "tok / session",
    cls: "c-num",
    note: "What this item costs you in EVERY session: tokens loaded into the model's context before you type anything, used or not. Not the size of the file — just the always-loaded part (name + description for skills, whole body for instruction files).",
  },
  { key: "fires", label: "fires", cls: "c-num" },
  {
    key: "tokPerFire",
    label: "tok / fire",
    cls: "c-num",
    note: "What one fire cost over the window: (always-in-context cost × sessions + body cost × fires) ÷ fires. An item that never fired shows what was paid for it instead, and sorts last in either direction.",
  },
  { key: "lastFired", label: "last fired" },
  { key: "findings", label: "findings" },
];

/**
 * A column where every row would print the same word is a fact about the
 * machine, not a discriminator — the same rule that hides the one-provider
 * filter bank. Uniformity is judged against the MODE's base inventory, not
 * the filtered view: columns must not appear and vanish as filters are
 * clicked, but the kind column rightly disappears in skills mode.
 */
function activeCols(base: UiItem[]): typeof COLS {
  const varies = (get: (i: UiItem) => string): boolean => new Set(base.map(get)).size > 1;
  return COLS.filter((c) => {
    if (c.key === "source") return varies((i) => i.source);
    if (c.key === "scope") return varies((i) => i.scope);
    if (c.key === "kind") return varies((i) => i.kind);
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
function costCell(item: UiItem, maxInjected: number, win: Window): string {
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
  // and the header's rent total cannot disagree about the same item.
  const deadWeight = isDeadWeight(item, maxInjected, win);
  // The window the verdict was reached in is THIS row's, which is not the
  // merged one for a provider whose store keeps its own history.
  const w = windowFor(win, item);
  const note = item.enabled
    ? `This item costs ${fmtInt(tok)} tokens in every session — loaded into the model's context before you type anything, whether or not it is used. The bar compares that cost against the most expensive item in your inventory.` +
      (deadWeight ? `\n\nDead weight: that cost is being paid with zero fires in the ${w.span} window.` : "")
    : `Off — costs nothing right now. Re-enabled, it would add ${fmtInt(tok)} tokens to every session.`;
  return `<td class="c-num c-cost${deadWeight ? " dw" : ""}" title="${esc(note)}"><span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span>${fmtInt(tok)}</td>`;
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

function tableHead(state: AppState, win: Window, cols: typeof COLS, items?: UiItem[]): string {
  // The span in a column label is the merged transcript window. Rows counted
  // out of another store are counted over ITS window, and each cell says so —
  // the header has to say that they do, or the label reads as the window every
  // figure under it was measured in.
  const others = otherWindows(win, items);
  const perRow = others
    ? `\n\nRows whose evidence comes from another provider's store are counted over that store's own window instead (${others}); every such cell states its window in its own tooltip.`
    : "";
  const noteFor = (key: SortKey, fallback?: string): string => {
    if (key === "fires" || key === "lastFired") return `${win.note}${perRow}`;
    if (key === "tokPerFire") return `${fallback ?? ""}${win.note ? `\n\n${win.note}${perRow}` : ""}`;
    return fallback ?? "";
  };
  // Tooltips on the right-hand columns anchor right, or they would push the
  // scrollport wider and put a horizontal scrollbar under the whole table.
  const RIGHT_TIPPED = new Set<SortKey>(["injected", "fires", "tokPerFire", "lastFired", "findings"]);
  const cells = cols.map((c) => {
    const active = state.sort.key === c.key;
    const arrow = active ? (state.sort.dir === 1 ? "▴" : "▾") : "";
    // No role="button": that would override the th's columnheader role and
    // cut every cell loose from its header in the accessibility tree. The
    // sort state is announced by aria-sort, which is what it is for.
    const sorted = active ? ` aria-sort="${state.sort.dir === 1 ? "ascending" : "descending"}"` : "";
    const note = noteFor(c.key, c.note);
    const title = note ? ` data-tip="${esc(note)}"` : "";
    const tipR = note && RIGHT_TIPPED.has(c.key) ? " tip-r" : "";
    const label =
      win.span && (c.key === "lastFired" || c.key === "fires" || c.key === "tokPerFire")
        ? `${c.label} · ${win.span}`
        : c.label;
    return `<th class="${c.cls ?? ""}${active ? " sorted" : ""}${tipR}" data-sort="${c.key}" tabindex="0"${sorted}${title}>${esc(label)}<s aria-hidden="true">${arrow}</s></th>`;
  }).join("");
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

function findingsCell(item: UiItem, win: Window): string {
  const flags = flagCount(item);
  const parts: string[] = [];
  if (flags > 0) {
    // The fire count rides on the badge only when both facts exist — a flag
    // on something that actually runs is a different fact from a flag on a
    // dormant file, and the qualifier says which count this is.
    const f = item.fires;
    const n = f ? f.lifetime?.invocations ?? f.invocations : 0;
    const fireTag = f && n > 0 ? ` · ${fmtInt(n)} fires` : "";
    const qual =
      f && n > 0
        ? f.lifetime && f.trackedSince
          ? `the flagged item has ${fmtInt(n)} recorded fires since tracking began ${fmtDay(f.trackedSince)}`
          : `the flagged item has ${fmtInt(n)} recorded fires in the ${win.span || "scanned"} window`
        : "";
    parts.push(
      `<span class="badge ${hasHigh(item) ? "danger" : "signal"}"${qual ? ` title="${esc(qual)}"` : ""}>▲ ${flags}${fireTag}</span>`
    );
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
  // Tonal, never amber: this is a modeled position in a drop order, not a
  // severity — and the row it sits on already carries its own state tag.
  const dropped = cut?.dropped
    ? `<span class="offtag cut" title="${esc(
        `Modelled as dropped: at ${fmtInt(cut.cumChars)} cumulative characters this description falls past the ~${fmtInt(cut.budget)}-char listing budget, so Claude Code would not load it — the skill still exists and can still be typed, it just stops auto-triggering. Freeing ${fmtInt(cut.need)} characters brings it back.\n\nThis replays Claude Code's documented drop order (least-invoked first) ranked on this ledger's own lifetime fire counts, which stand in for counters the harness keeps to itself. A model of the rule, not a readout of it.`
      )}">listing dropped</span>`
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

function row(
  item: UiItem,
  idx: number,
  state: AppState,
  mergedWin: Window,
  maxInjected: number,
  cols: typeof COLS,
  sessions: number,
  cut?: CutFact
): string {
  const f = item.fires;
  // Every figure in this row was counted out of ONE provider's store, so every
  // qualifier in it names that store's window. The merged window describes the
  // transcript scan, and for a cursor rule — counted over a conversation store
  // reaching back a year — it describes nothing this row contains.
  const win = windowFor(mergedWin, item);
  const noun = sessionNoun(item);
  const has = (key: SortKey): boolean => cols.some((c) => c.key === key);
  // An agent leaves a dispatch record by construction (S2 banks every
  // Agent/Task launch), so "this kind is untrackable" is the wrong reason for
  // an agent n/a — that cell means the ledger holding those launches could not
  // be read for this scan. The rail states which failure; the cell states that
  // the measurement is missing rather than zero.
  const untracked =
    item.kind === "agent"
      ? `n/a — no dispatch record reached this row for this scan. Agent launches ARE recorded, so this is an absent measurement (see the caveat in the filter rail), never a zero.`
      : `n/a — this kind leaves no dispatch record in local transcripts, so its use cannot be counted either way`;
  // "0" and "never" are absolute-sounding words for a window-limited fact, so
  // both carry the window in their text or their tooltip.
  const firedNote = (u: NonNullable<UiItem["fires"]>): string =>
    `${fmtInt(u.invocations)} invocation${u.invocations === 1 ? "" : "s"} across ${fmtInt(u.sessions)} ${noun}${u.sessions === 1 ? "" : "s"}` +
    `${u.firstFired ? ` · first ${fmtDay(u.firstFired)}` : ""}${u.lastFired ? ` · last ${fmtDay(u.lastFired)}` : ""}` +
    (u.lifetime
      ? `\n${fmtInt(u.lifetime.invocations)} lifetime across ${fmtInt(u.lifetime.sessions)} ${noun}${u.lifetime.sessions === 1 ? "" : "s"}${u.trackedSince ? ` since tracking began ${fmtDay(u.trackedSince)}` : ""} — lifetime counts come from the durable ledger (dated events); the window count is a separate pass over this provider's own local store, a different method.`
      : "") +
    `\n\n${win.note}`;
  // Fires are recorded by dispatch name; a shadowed disabled copy never
  // dispatches, so repeating the name's count here would double-report it.
  const shadowed = !!item.twinPath && !item.enabled;
  const shadowNote =
    "fires are recorded by dispatch name, and an enabled copy of this name exists — its row carries the history";
  // The never-fired cell states the age fact inline when provenance can date
  // the item: "never" alone is a claim, "never though installed 62d ago" is
  // the fact worth acting on. Without a provenance date it stays a plain "0".
  const neverCell = (): string => {
    const p = item.provenance;
    const age = p ? daysAgo(p.installedAt, win.asOf) : undefined;
    return p && age !== undefined
      ? `<td class="c-num zero" title="${esc(`${provVerb(p)} ${fmtDay(p.installedAt)} (date from ${PROVENANCE_LABEL[p.source]}) — no recorded fires.\n\n${win.note}`)}">never · ${provVerb(p)} ${fmtInt(age)}d</td>`
      : `<td class="c-num zero" title="${esc(win.note)}">0</td>`;
  };
  // Table-level dispatch and waste facts: "never auto-fired" only at 100%
  // typed, the interrupted badge only when interrupts exist — a badge appears
  // when its fact does, never as empty chrome. Tonal, not amber: these are
  // measurements, not states. Shadowed rows carry no fires surface at all.
  const typedOnlyBadge =
    !shadowed && f && f.byChannel && f.byChannel.auto === 0 && f.byChannel.typed > 0
      ? ` <span class="badge fact" title="${esc(`every recorded fire was user-typed${f.trackedSince ? ` since tracking began ${fmtDay(f.trackedSince)}` : ""} — the model has not reached for this on its own`)}">never auto-fired</span>`
      : "";
  const interruptedBadge =
    !shadowed && f && f.interruptedAfter > 0
      ? ` <span class="badge fact" title="${esc(`${fmtInt(f.interruptedAfter)} of ${fmtInt(f.invocations)} fires in the ${win.span || "scanned"} window were interrupted mid-run — the body tokens had already loaded when the run stopped`)}">${fmtInt(f.interruptedAfter)} interrupted (~${fmtInt(tokens(item.bodyChars * f.interruptedAfter))} tok${f.invocations > 0 ? `, ${Math.round((f.interruptedAfter / f.invocations) * 100)}% of fires` : ""})</span>`
      : "";
  // Tried and dropped: every recorded fire inside a single 7-day span. The
  // payload refuses to call one fire a burst, so the badge can only appear
  // where at least two fires bracket a span — the fact, then the badge.
  //
  // Withheld while that burst is still RECENT (the same 4-ISO-week measure the
  // trend glyph calls "new"): an item first used yesterday has all its fires
  // inside one span too, and "dropped" would be a verdict on something that
  // has barely started. The row still says "∗ new", and the drawer still
  // states the span either way.
  const sp = shadowed ? undefined : f?.spread;
  const burstBadge =
    sp?.oneBurst && f && trendOf(f.weeklyBins, win.asOf)?.trend !== "new"
      ? ` <span class="badge fact" title="${esc(
          `all ${fmtInt(firesCount(f))} recorded fires landed within ${sp.spanDays === 0 ? "a single day" : `one ${fmtInt(sp.spanDays)}-day span`}` +
            `${f.lifetime?.firstFired ?? f.firstFired ? ` (${fmtDay(f.lifetime?.firstFired ?? f.firstFired)} → ${fmtDay(f.lifetime?.lastFired ?? f.lastFired)})` : ""}` +
            `${f.quiet ? `, and nothing since — ${fmtInt(f.quiet.days)}d ago` : ", and nothing since"}.` +
            `${f.trackedSince ? ` Measured over the ledger's record since ${fmtDay(f.trackedSince)}.` : ""}`
        )}">tried &amp; dropped</span>`
      : "";
  // Every fire in one project, while the item is loaded in all of them. A
  // scope fact, but it lives beside the fires it is about — the scope column
  // disappears whenever every row shares one scope.
  const scopeIn = shadowed ? undefined : item.scopeNote?.allFiresIn;
  // The label is clipped at a width the column can carry — a project display
  // name is a basename, but nothing stops one being 60 characters, and a
  // nowrap cell would widen the whole table for it. The full name is in the
  // title, and in the drawer's relationships section.
  const scopeShort = scopeIn && scopeIn.length > 22 ? `${scopeIn.slice(0, 21)}…` : scopeIn;
  const scopeBadge = scopeIn
    ? ` <span class="badge fact" title="${esc(
        `every recorded fire of this ${item.scope}-scoped item landed in one project: ${scopeIn}. Its always-in-context cost is paid in every session in every project; its recorded use is in that one.`
      )}">only in ${esc(scopeShort)}</span>`
    : "";
  const firesCell = shadowed
    ? `<td class="c-num na" title="${esc(shadowNote)}">—</td>`
    : f === undefined
      ? `<td class="c-num na" title="${esc(untracked)}">n/a</td>`
      : f === null
        ? neverCell()
        : `<td class="c-num" title="${esc(firedNote(f))}">${
            f.lifetime
              ? win.span
                ? `${fmtInt(f.lifetime.invocations)} <span class="winpart">· ${fmtInt(f.invocations)} in ${win.span}</span>`
                : fmtInt(f.lifetime.invocations)
              : fmtInt(f.invocations)
          }${trendGlyph(f, win, quietBudgetNote(item, f, win))}${typedOnlyBadge}${burstBadge}${scopeBadge}${interruptedBadge}</td>`;
  // tok/fire: a ratio when the window has fires to divide by; what was paid,
  // stated as a fact, when it does not. Never Infinity, never NaN.
  const ratio = tokPerFire(item, sessions);
  const tokFireCell = (): string => {
    if (shadowed) return `<td class="c-num na" title="${esc(shadowNote)}">—</td>`;
    if (f === undefined) return `<td class="c-num na" title="${esc(untracked)}">n/a</td>`;
    if (f && ratio !== undefined) {
      const s = Math.max(sessions, f.sessions);
      const method =
        `≈ (${fmtInt(tokens(item.injectedChars))} tok/session × ${fmtInt(s)} scanned sessions + ${fmtInt(tokens(item.bodyChars))} tok body × ${fmtInt(f.invocations)} fires) ÷ ${fmtInt(f.invocations)} fires — window figures on both sides. The session count is this payload's transcript total, which spans every provider whose transcripts it reads, not this row's alone.\n\n${win.note}`;
      return `<td class="c-num" title="${esc(method)}">${fmtInt(ratio)}</td>`;
    }
    if (!item.enabled)
      return `<td class="c-num na" title="off — no always-in-context cost is being paid">—</td>`;
    // No session total for this provider, so there is nothing honest to
    // multiply the always-in-context cost by. The page's transcript total
    // counts Claude transcripts and Codex rollouts; pricing a Cursor rule with
    // it would bill this row for sessions its harness was never in.
    if (!comparableSessions(item))
      return `<td class="c-num na" title="${esc(
        `n/a — this payload carries no ${noun} total for ${item.source}. The transcript count it would otherwise divide by belongs to other harnesses' stores, and a cost per fire built from another store's ${noun}s would be a ratio of two different measurements.\n\n${win.note}`
      )}">n/a</td>`;
    if (!win.span || sessions <= 0) return `<td class="c-num na" title="${esc(win.note)}">n/a</td>`;
    const paid = tokens(item.injectedChars * sessions);
    const tail = f === null ? "never fired" : `none in ${win.span}`;
    const note =
      `${fmtInt(tokens(item.injectedChars))} tok × ${fmtInt(sessions)} scanned sessions — this payload's transcript total across the providers it reads — paid with zero fires recorded in this row's ${win.span} window, so there is no per-fire cost to state.` +
      (f && f.lifetime && f.lifetime.invocations > 0
        ? `\n${fmtInt(f.lifetime.invocations)} lifetime fire${f.lifetime.invocations === 1 ? "" : "s"} exist${f.trackedSince ? ` since tracking began ${fmtDay(f.trackedSince)}` : ""}, outside this window.`
        : "") +
      `\n\n${win.note}`;
    return `<td class="c-num zero" title="${esc(note)}">paid ${fmtInt(paid)} · ${tail}</td>`;
  };
  const last = shadowed
    ? `<td class="na" title="${esc(shadowNote)}">—</td>`
    : f === undefined
      ? `<td class="na" title="${esc(untracked)}">n/a</td>`
      : f === null
        ? `<td class="zero" title="${esc(win.note)}">${esc(win.none)}</td>`
        : `<td title="${esc(firedNote(f))}">${fmtDay(f.lastFired) || "—"}</td>`;
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
  // control that would do it. Only where the action exists (a togglable,
  // currently-enabled item) and only where there is something to save — a
  // "−0 tok" affordance would be chrome offering nothing.
  const saving = item.togglable && item.enabled ? tokens(item.injectedChars) : 0;
  const saveBtn =
    saving > 0
      ? `<button class="act save" data-toggle="${item.id}" data-saving-chars="${item.injectedChars}" aria-label="${esc(`disable ${item.name} — stops paying ${fmtInt(saving)} tokens every session`)}" title="${esc(
          `Disable — stops paying ${fmtInt(saving)} tok in every session (${fmtInt(item.injectedChars)} chars of always-in-context text). The file is moved to ~/.claude/skills-disabled, not deleted, and its fire history is kept.`
        )}">−${fmtInt(saving)} tok</button>`
      : "";
  return `<tr class="${cls}" data-id="${item.id}" tabindex="0"${style}>
    <td class="c-sw">${switchCell(item)}</td>
    <td class="c-name" title="${esc(nameTip)}">${nameCell(item, cut)}</td>
    ${has("source") ? `<td class="dim">${esc(item.source)}</td>` : ""}
    ${has("kind") ? `<td class="c-kind" title="${esc(KIND_NOTE[item.kind] ?? "")}"><i class="kg kg-${esc(item.kind)}" aria-hidden="true">${KIND_GLYPH[item.kind] ?? ""}</i>${esc(item.kind)}</td>` : ""}
    ${has("scope") ? `<td class="dim">${item.scope === "user" ? "user" : "proj"}</td>` : ""}
    ${costCell(item, maxInjected, win)}
    ${firesCell}
    ${tokFireCell()}
    ${last}
    <td>${findingsCell(item, win)}</td>
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
  const base = modeBase(payload, state);
  const cols = activeCols(base);
  const span = cols.length + 1;
  const items = visibleItems(payload, state);
  // Meter scale comes from the WHOLE inventory, not the filtered view — a
  // bar that grows when you filter would be lying about relative cost.
  const maxInjected = Math.max(...payload.items.map((i) => i.injectedChars), 0);
  const { loose, groups } = grouped(items);
  const sessions = payload.history?.transcriptFiles ?? 0;
  const cut = cutIndex(payload);
  // The divider marks where the modeled cut falls. The table sorts on whatever
  // column you chose, so "everything below this line is dropped" is only true
  // when the dropped rows happen to form the tail of the current order — which
  // is checked, and said either way. Every dropped row carries its own tag
  // regardless, so the fact never depends on the line being where you expect.
  const ordered = [...loose, ...groups.flatMap((g) => g.items)];
  const listedSeq = ordered
    .map((i) => cut?.byId.get(i.id)?.dropped)
    .filter((d): d is boolean => d !== undefined);
  const firstDropped = listedSeq.indexOf(true);
  const isTail = firstDropped >= 0 && listedSeq.slice(firstDropped).every(Boolean);
  let cutPlaced = false;
  const cutDivider = (item: UiItem): string => {
    if (cutPlaced || !cut || cut.dropped === 0 || !cut.byId.get(item.id)?.dropped) return "";
    cutPlaced = true;
    const sorting = COLS.find((c) => c.key === state.sort.key)?.label ?? state.sort.key;
    const where = isTail
      ? `every listed row below this line is dropped, in the order you are sorted by (${esc(sorting)})`
      : `the first dropped row in this sort (${esc(sorting)}) — the model ranks most-fired first, so others sit above the line here; each carries its own tag`;
    // One line. The placement rule and the modelling caveat are on the row's
    // tooltip rather than wrapped across two lines of prose inside the table —
    // as rendered text they cost the inventory another ~30px of height on
    // every scroll, for a caveat you read once.
    return `<tr class="cutrow" data-tip="${esc(
      `${where}. Modelled from this ledger's own fire counts, standing in for the invocation counters Claude Code keeps to itself.`
    )}"><td colspan="${span}">
      <span class="engr">listing cut</span>
      <span class="cutfig"><b class="dgr">${fmtInt(cut.dropped)}</b> of ${fmtInt(cut.listed)} description${plural(cut.listed)} fall past the ~${fmtInt(cut.budget)}-char budget${cut.headroom > 0 ? ` · free ${fmtInt(cut.headroom)} chars and every one loads` : ""}</span>
      <button class="inlineclear" data-panel-to="budget">open the budget panel</button>
    </td></tr>`;
  };
  const supFor = (plugin: string, marketplace?: string): UiSuperseded | undefined =>
    (payload.superseded ?? []).find(
      (s) => s.plugin === plugin && (s.marketplace ?? "") === (marketplace ?? "")
    );
  let idx = 0;
  const looseRows = loose
    .map((i) => cutDivider(i) + row(i, idx++, state, win, maxInjected, cols, sessions, cut?.byId.get(i.id)))
    .join("");
  const groupRows = groups
    .map(
      (g) =>
        groupRow(g, span, state.busy, supFor(g.plugin, g.marketplace)) +
        g.items
          .map((i) => cutDivider(i) + row(i, idx++, state, win, maxInjected, cols, sessions, cut?.byId.get(i.id)))
          .join("")
    )
    .join("");
  // Two different empty states: filters that matched nothing (clear them), and
  // a mode whose base is empty (the way out is the mode, not the filters).
  const none =
    items.length === 0
      ? base.length === 0
        ? `<tr class="nomatch"><td colspan="${span}">no skills in this inventory — <button class="inlineclear" data-mode="all">show everything (${fmtInt(payload.items.length)} items)</button></td></tr>`
        : `<tr class="nomatch"><td colspan="${span}">nothing matches this filter — this view has ${fmtInt(base.length)} items. <button class="inlineclear" data-clear>clear filters</button></td></tr>`
      : "";
  return `<table class="inv" aria-label="instruction inventory">
    <thead>${tableHead(state, win, cols, base)}</thead>
    <tbody>${looseRows}${groupRows}${none}</tbody>
  </table>`;
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
  // Stated in full, every time, next to the number it qualifies — the window
  // is a transcript-retention limit and the number means nothing without it.
  const fireCaveat =
    f === undefined || !w.note ? "" : `<p class="caveat-note">${esc(w.note)}</p>`;

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
    ? `<section>
        <span class="engr">provenance</span>
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
      </section>`
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

  // --- cost: per-agent run cost ---------------------------------------------
  // Near-exact where per-skill cost never can be, because an agent's work
  // lives in a transcript of its own — and stated only beside the method and
  // the denominator that make the figure readable.
  const ac = item.agentCost;
  const launches = fx ? firesCount(fx) : 0;
  const agentCostBlock = ac
    ? kv(
        "run cost",
        `<b>${fmtInt(ac.totalTokens)}</b> tok total · median <b>${fmtInt(ac.medianTokens)}</b> tok`
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
      ? `<section><span class="engr">content health</span>${freshBlock}${refBlock}${bundledBlock}</section>`
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
      ? `<section><span class="engr">relationships</span>${confusableBlock}${crossBlock}${nearMissBlock}${scopeBlock}${collisionBlock}</section>`
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
    ? `<section>
        <span class="engr">plugin</span>
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
      </section>`
    : "";

  // --- since disabling -------------------------------------------------------
  // There is no disable log. The date below is evidence of a kind, and it is
  // labeled as the kind it is.
  const ds = item.disabledSafety;
  const disabledSection = ds
    ? `<section>
        <span class="engr">since disabling</span>
        ${
          ds.disabledAt
            ? factline(
                `off since <b>${esc(fmtDay(ds.disabledAt))}</b> or earlier${ds.days !== undefined ? ` <span class="dim">· at least ${fmtInt(ds.days)}d</span>` : ""}`
              ) +
              (ds.disabledAtSource === "ctime"
                ? `<p class="kv-note">${esc(
                    "Nothing logs a disable. That date is the directory's ctime: moving a skill into skills-disabled is a rename, which leaves mtime alone but bumps ctime — and so does anything else that touches the directory's metadata. Treat it as an upper bound on the date, and the count below as counted only from it."
                  )}</p>`
                : "")
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
      </section>`
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
                // An imported row names its method inline: no transcript ever
                // sat behind it, and its open affordance says what it opens.
                (ev.backfill ? `<span class="evmark">backfilled</span>` : "");
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
          return `<section>
            <span class="engr">invocations</span>
            <p class="evcap dim">${cap} · newest first${fx.trackedSince ? ` · tracked since ${fmtDay(fx.trackedSince)}` : ""} · ${opens}</p>
            <div class="evlist">${rows}</div>
          </section>`;
        })()
      : "";

  const fm = item.frontmatter
    ? `<section><span class="engr">frontmatter</span><table class="fmt">${Object.entries(item.frontmatter)
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join("")}</table></section>`
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
      ? `<section><span class="engr">security findings</span>${flagFindings.map(findingBlock).join("")}${infoBlock}</section>`
      : `<section><span class="engr">security findings</span><p class="dim">none for this item</p></section>`;

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
        <span class="engr">description</span>
        <p>${item.description ? esc(item.description) : `<span class="dim">none declared</span>`}</p>
      </section>
      <section>
        <span class="engr">file</span>
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
      </section>
      <section>
        <span class="engr">cost</span>
        ${kv(
          "always in context",
          `<b>${fmtInt(tokens(item.injectedChars))}</b> tok ≈ ${fmtInt(item.injectedChars)} chars${item.enabled ? "" : " <span class='dim'>(if re-enabled)</span>"}`
        )}
        <p class="kv-note">${esc(INJECTION_NOTE[item.injection])}</p>
        ${kv("only when it runs", `<b>${fmtInt(tokens(item.bodyChars))}</b> tok ≈ ${fmtInt(item.bodyChars)} chars`)}
        <p class="kv-note">The rest of the file. Loaded only after this item is actually invoked, so it costs nothing on a session that never uses it.</p>
        ${agentCostBlock}
      </section>
      ${provSection}
      ${pluginSection}
      <section>
        <span class="engr">fires</span>
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
      </section>
      ${evSection}
      ${healthSection}
      ${relSection}
      ${disabledSection}
      ${fm}
      ${findings}
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

/** Everything except the drawer, which main.ts keeps as a persistent node. */
export function renderPage(payload: UiPayload, state: AppState): string {
  // The backfill horizon rides the window line: the typed channel reaches
  // further back than any surviving transcript, and the two claims must not
  // be conflated — the extension names its method inline.
  const hist = payload.history
    ? `window ${fmtDay(payload.history.windowStart) || "?"} → ${fmtDay(payload.history.windowEnd) || "?"} · ${fmtInt(payload.history.transcriptFiles)} transcripts` +
      (payload.history.backfilledSince
        ? ` · typed-channel history extends to ${fmtDay(payload.history.backfilledSince)} (backfilled)`
        : "")
    : "history not scanned";
  return `
  <div class="mast">
    <div class="ident">
      <span class="brand">context-audit</span>
      <span class="mode">instruction inventory</span>
    </div>
    <div class="plate">
      <span>rev ${esc(payload.version)}</span>
      <span>scan ${esc(fmtStamp(payload.generatedAt))} · ${fmtInt(payload.tookMs)} ms</span>
      <span>${esc(hist)}</span>
      ${caveatChips(payload)}
      <button class="btn rescan" data-rescan${state.busy ? " disabled" : ""}>${state.busy ? "scanning…" : "rescan"}</button>
    </div>
  </div>
  <div class="gratbox">${graticule()}${state.animate && state.sweep ? `<div class="sweep"></div>` : ""}</div>
  <div class="readouts">${headerReadouts(payload, state)}</div>
  ${portfolioStrip(payload, state)}
  ${filterRail(payload, state)}
  <div id="results">${renderResults(payload, state)}</div>`;
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

/**
 * Which panels this MACHINE has a question for. Only the budget panel is ever
 * withheld, and for the reason the header readout is: the skill listing is a
 * Claude Code mechanic, and a Codex- or Cursor-only setup is not subject to
 * it. Offering the door would put a Claude-specific budget in front of someone
 * who has no listing to be over or under — the same claim the header refuses
 * to make as a 0%. Every other panel's empty state is a real reading of this
 * machine ("one provider here", "no weekly history yet"), so it stays.
 */
function panelApplies(key: string, payload: UiPayload): boolean {
  return key !== "budget" || !!payload.header.listing || !!payload.budgetCut;
}

/** The selected panel, falling back to the table for anything unavailable. */
export const panelKey = (payload: UiPayload, state: AppState): string =>
  PANELS.some((p) => p.key === state.panel) && panelApplies(state.panel, payload)
    ? state.panel
    : "inventory";

/**
 * The panel selector: one engraved, single-select bank above the results.
 *
 * It is NOT a filter and must not read as one — the rail's chips narrow which
 * items are in play, this switches which reading of them is drawn — so it sits
 * with the results rather than in the rail, and it carries the same amber the
 * sorted column header does to say which one is live.
 */
function panelBank(payload: UiPayload, state: AppState): string {
  const active = panelKey(payload, state);
  const btns = PANELS.filter((p) => panelApplies(p.key, payload)).map(
    (p) =>
      `<button class="panel-btn${p.key === active ? " on" : ""}" data-panel-to="${esc(p.key)}" aria-pressed="${p.key === active}" data-tip="${esc(p.note)}">${esc(p.label)}</button>`
  ).join("");
  return `<div class="panelbank">
    <span class="engr" data-tip="${esc(
      "Which reading of the inventory to draw. A panel changes the drawing, never the items: your filters, your scope and your search all carry across, and the table is always one click away."
    )}">panel</span>
    <span class="panelset" role="group" aria-label="analysis panel">${btns}</span>
  </div>`;
}

export function renderResults(payload: UiPayload, state: AppState): string {
  const shown = payload.items.length === 0 ? 0 : visibleItems(payload, state).length;
  // The denominator is what this MODE could show; the readout names the layer
  // so "54" in skills mode never reads as the whole machine.
  const base = modeBase(payload, state).length;
  // An empty inventory has nothing to read four ways: the onboarding empty
  // state is the whole answer, and a panel bank over it would be five doors
  // onto the same blank room.
  // The bank itself lives in the filter rail, not here: as its own full-width
  // band it cost the table another 42px on top of the portfolio strip, and
  // three stacked control bands left the inventory under a third of the page.
  const key = payload.items.length === 0 ? "inventory" : panelKey(payload, state);
  const body =
    key === "inventory"
      ? `<div class="tablebox">${table(payload, state)}</div>`
      // Per-provider windows ride through so the overlap matrix captions each
      // column with the retention horizon that column was measured over — one
      // shared date would claim a window two of the three providers never had.
      : renderPanel(key, payload, state, payload.providerWindows);
  return `${body}
  ${logPanel(state)}
  <div class="foot">
    <span class="live"><i></i>127.0.0.1 — local only, nothing leaves the machine</span>
    <span>${fmtInt(shown)} / ${fmtInt(base)} ${state.mode === "skills" ? "skills" : "items"} ${key === "inventory" ? "shown" : "in scope"}</span>
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
