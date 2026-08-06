// Pure string rendering — no DOM APIs anywhere in this file. That is a load-
// bearing constraint, not a style choice: the frontend smoke test imports this
// module into Node and renders fixture payloads without a browser rig.
import type {
  ListingBudget,
  Provenance,
  ProvenanceSource,
  SecurityFinding,
  UiFires,
  UiItem,
  UiPayload,
} from "../../types.js";

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
  s.providers.length > 0 || s.kinds.length > 0 || s.lens !== "all" || s.query.trim() !== "";

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
}

export function usageWindow(payload: UiPayload): Window {
  const h = payload.history;
  const listingCrossedAt = payload.header.listing?.crossedAt;
  if (!h?.windowStart || !h?.windowEnd) {
    return {
      span: "",
      note: "no local transcripts were scanned, so no usage can be counted",
      none: "no data",
      asOf: payload.generatedAt,
      listingCrossedAt,
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
  };
}

const flagCount = (i: UiItem): number => i.findings.filter((f) => f.level === "flag").length;
const hasHigh = (i: UiItem): boolean =>
  i.findings.some((f) => f.level === "flag" && (f.severity === "critical" || f.severity === "high"));

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
  agent: "An agent: a subagent definition dispatched by the model. Its description is always in context; local transcripts keep no dispatch record for agents, so fires are n/a.",
  command: "A slash command: fires only when you type /name.",
  prompt: "A Codex prompt: fires only when you type /name.",
  rule: "A Cursor rule: applies by glob, always, or on request depending on its frontmatter.",
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
  return sortItems(
    modeBase(payload, state).filter(
      (i) =>
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
  const base = modeBase(payload, state);
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
  sub2 = ""
): string {
  const style = animate ? ` style="animation-delay:${180 + idx * 70}ms"` : "";
  const title = note ? ` data-tip="${esc(note)}"` : "";
  return `<div class="readout${animate ? " settle" : ""}${tone}"${style}${title}>
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
      `What your setup costs on every single session, whether or not you use any of it (≈ ${fmtInt(h.injectedChars)} characters). Skills and agents pay their name + description; CLAUDE.md and always-apply rules pay their whole body. Skill bodies are NOT counted here — those load only when the skill runs. Disabled items are excluded.`
    ),
    readout(
      "no fires in window",
      fmtInt(h.neverFired),
      "",
      quietSub,
      2,
      state.animate,
      "",
      `${win.note} Only kinds the transcripts record dispatch for are counted here (skills and commands); agents and instruction files have no dispatch record, so they are not called unused.` +
        (rent
          ? ` Silent-item rent: the summed always-in-context cost of enabled items that predate the window start yet recorded no fires in it — paid every session either way.`
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
  const lensBank = bank(
    win.span ? `view · ${win.span}` : "view",
    [
      chip(
        "lens",
        "fired",
        "fired",
        n("lens", "fired"),
        state.lens === "fired",
        `Items with at least one recorded invocation in the scanned window. ${win.note}`
      ),
      chip(
        "lens",
        "never-fired",
        "no fires",
        n("lens", "never-fired"),
        state.lens === "never-fired",
        win.note
      ),
      chip("lens", "enabled", "active", n("lens", "enabled"), state.lens === "enabled",
        "Items currently live: their always-in-context cost is being paid every session."),
      chip("lens", "disabled", "off", n("lens", "disabled"), state.lens === "disabled",
        "Items sitting in ~/.claude/skills-disabled. They cost nothing until re-enabled."),
      chip("lens", "flagged", "flagged", n("lens", "flagged"), state.lens === "flagged",
        "Items carrying at least one security flag."),
    ].join(""),
    win.note
  );

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

  const caveat =
    payload.pluginResolution === "newest-fallback"
      ? `<span class="caveat tip-r" data-tip="installed_plugins.json was missing or unreadable">plugin versions: newest-cached fallback</span>`
      : "";

  // A broken ledger must degrade loudly: lifetime, provenance and dead-weight
  // are absent from this payload, and the page says so instead of quietly
  // rendering window-only figures as if they were the whole story.
  const ledgerCaveat = payload.ledgerCaveat
    ? `<span class="caveat tip-r" data-tip="${esc(payload.ledgerCaveat)}">usage ledger unavailable — window figures only</span>`
    : "";

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
    ${clear}
    ${flaggedElsewhere}
    ${caveat}
    ${ledgerCaveat}
  </div>`;
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
  // an expensive busy one are both fine. No window, no claim: a scan that
  // found zero transcripts sets fires=null on every tracked row, and "zero
  // fires" without a window is exactly the unsupported absolute this page
  // promises never to print. The age gate is the header rent's, verbatim:
  // provenance must date the install BEFORE the window start — an item
  // younger than the window is "too new to judge" and shows the install fact
  // in its fires cell instead of an amber verdict here.
  const preDatesWindow =
    item.provenance !== undefined && !!win.start && item.provenance.installedAt < win.start;
  const deadWeight = item.enabled && item.fires === null && pct >= 25 && !!win.span && preDatesWindow;
  const note = item.enabled
    ? `This item costs ${fmtInt(tok)} tokens in every session — loaded into the model's context before you type anything, whether or not it is used. The bar compares that cost against the most expensive item in your inventory.` +
      (deadWeight ? `\n\nDead weight: that cost is being paid with zero fires in the ${win.span} window.` : "")
    : `Off — costs nothing right now. Re-enabled, it would add ${fmtInt(tok)} tokens to every session.`;
  return `<td class="c-num c-cost${deadWeight ? " dw" : ""}" title="${esc(note)}"><span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span>${fmtInt(tok)}</td>`;
}

function tableHead(state: AppState, win: Window, cols: typeof COLS): string {
  const noteFor = (key: SortKey, fallback?: string): string => {
    if (key === "fires" || key === "lastFired") return win.note;
    if (key === "tokPerFire") return `${fallback ?? ""}${win.note ? `\n\n${win.note}` : ""}`;
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
  return `<button class="sw${item.enabled ? " on" : ""}" data-toggle="${item.id}" role="switch" aria-checked="${item.enabled}" aria-label="${item.enabled ? "disable" : "enable"} ${esc(item.name)}" title="${item.enabled ? "disable" : "enable"}"><i></i></button>`;
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

function nameCell(item: UiItem): string {
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
  return `${name}${off}${shadowed}`;
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
  win: Window,
  maxInjected: number,
  cols: typeof COLS,
  sessions: number
): string {
  const f = item.fires;
  const has = (key: SortKey): boolean => cols.some((c) => c.key === key);
  const untracked = `n/a — this kind leaves no dispatch record in local transcripts, so its use cannot be counted either way`;
  // "0" and "never" are absolute-sounding words for a window-limited fact, so
  // both carry the window in their text or their tooltip.
  const firedNote = (u: NonNullable<UiItem["fires"]>): string =>
    `${fmtInt(u.invocations)} invocation${u.invocations === 1 ? "" : "s"} across ${fmtInt(u.sessions)} session${u.sessions === 1 ? "" : "s"}` +
    `${u.firstFired ? ` · first ${fmtDay(u.firstFired)}` : ""}${u.lastFired ? ` · last ${fmtDay(u.lastFired)}` : ""}` +
    (u.lifetime
      ? `\n${fmtInt(u.lifetime.invocations)} lifetime across ${fmtInt(u.lifetime.sessions)} session${u.lifetime.sessions === 1 ? "" : "s"}${u.trackedSince ? ` since tracking began ${fmtDay(u.trackedSince)}` : ""} — lifetime counts come from the durable ledger (dated events); the window count comes from transcript lines, a different method.`
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
          }${trendGlyph(f, win, quietBudgetNote(item, f, win))}${typedOnlyBadge}${interruptedBadge}</td>`;
  // tok/fire: a ratio when the window has fires to divide by; what was paid,
  // stated as a fact, when it does not. Never Infinity, never NaN.
  const ratio = tokPerFire(item, sessions);
  const tokFireCell = (): string => {
    if (shadowed) return `<td class="c-num na" title="${esc(shadowNote)}">—</td>`;
    if (f === undefined) return `<td class="c-num na" title="${esc(untracked)}">n/a</td>`;
    if (f && ratio !== undefined) {
      const s = Math.max(sessions, f.sessions);
      const method =
        `≈ (${fmtInt(tokens(item.injectedChars))} tok/session × ${fmtInt(s)} sessions + ${fmtInt(tokens(item.bodyChars))} tok body × ${fmtInt(f.invocations)} fires) ÷ ${fmtInt(f.invocations)} fires — window figures on both sides.\n\n${win.note}`;
      return `<td class="c-num" title="${esc(method)}">${fmtInt(ratio)}</td>`;
    }
    if (!item.enabled)
      return `<td class="c-num na" title="off — no always-in-context cost is being paid">—</td>`;
    if (!win.span || sessions <= 0) return `<td class="c-num na" title="${esc(win.note)}">n/a</td>`;
    const paid = tokens(item.injectedChars * sessions);
    const tail = f === null ? "never fired" : `none in ${win.span}`;
    const note =
      `${fmtInt(tokens(item.injectedChars))} tok × ${fmtInt(sessions)} sessions in the ${win.span} window, paid with zero fires recorded in it — there is no per-fire cost to state.` +
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
    state.selected === item.id ? "sel" : "",
    state.animate ? "settle" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style = state.animate ? ` style="animation-delay:${240 + Math.min(idx, 28) * 14}ms"` : "";
  // The description is what a name like `harden` means — reachable from the
  // row, not only from the drawer. The path rides along underneath it.
  const nameTip = item.description ? `${item.description}\n\n${item.path}` : item.path;
  return `<tr class="${cls}" data-id="${item.id}" tabindex="0"${style}>
    <td class="c-sw">${switchCell(item)}</td>
    <td class="c-name" title="${esc(nameTip)}">${nameCell(item)}</td>
    ${has("source") ? `<td class="dim">${esc(item.source)}</td>` : ""}
    ${has("kind") ? `<td class="c-kind" title="${esc(KIND_NOTE[item.kind] ?? "")}"><i class="kg kg-${esc(item.kind)}" aria-hidden="true">${KIND_GLYPH[item.kind] ?? ""}</i>${esc(item.kind)}</td>` : ""}
    ${has("scope") ? `<td class="dim">${item.scope === "user" ? "user" : "proj"}</td>` : ""}
    ${costCell(item, maxInjected, win)}
    ${firesCell}
    ${tokFireCell()}
    ${last}
    <td>${findingsCell(item, win)}</td>
    <td class="c-act"><button class="act" data-open="${item.id}" title="open in editor">edit</button></td>
  </tr>`;
}

function groupRow(
  g: { plugin: string; version: string; marketplace?: string; latest?: string; items: UiItem[] },
  span: number,
  busy?: boolean
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
  return `<tr class="grp"><td colspan="${span}"><span class="engr">plugin</span> ${esc(g.plugin)} <span class="ver">${esc(g.version)}</span>${upd}<span class="dim">${mp} · ${g.items.length} item${g.items.length === 1 ? "" : "s"} · read-only${off}</span>${updBtn}</td></tr>`;
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
  let idx = 0;
  const looseRows = loose.map((i) => row(i, idx++, state, win, maxInjected, cols, sessions)).join("");
  const groupRows = groups
    .map((g) => groupRow(g, span, state.busy) + g.items.map((i) => row(i, idx++, state, win, maxInjected, cols, sessions)).join(""))
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
    <thead>${tableHead(state, win, cols)}</thead>
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
  const w = win ?? { span: "", note: "", none: "no data" };
  // Breadth carries its denominator: "across 3 of 87 sessions (3%)" — the
  // share-of-work fact, both figures from the same transcript window. The
  // denominator is skew-guarded the way tokPerFire's is, and absent (falling
  // back to the bare count) when no transcript total was threaded through.
  const breadthOf = (u: UiFires): string => {
    const denom = totalSessions > 0 ? Math.max(totalSessions, u.sessions) : 0;
    return denom > 0
      ? `across <b>${fmtInt(u.sessions)}</b> of <b>${fmtInt(denom)}</b> session${denom === 1 ? "" : "s"} (${Math.round((u.sessions / denom) * 100)}%)`
      : `across <b>${fmtInt(u.sessions)}</b> session${u.sessions === 1 ? "" : "s"}`;
  };
  const fireLine =
    item.twinPath && !item.enabled
      ? `<span class="na">shadowed — fires are recorded by dispatch name, and the enabled copy of this name carries the history</span>`
      : f === undefined
      ? `<span class="na">n/a — this kind leaves no dispatch record, so its use cannot be counted either way</span>`
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
  const provSection = prov
    ? `<section>
        <span class="engr">provenance</span>
        ${kv(
          prov.source === "mtime" ? "last edited" : "installed",
          `<b>${esc(fmtDay(prov.installedAt))}</b>${provAge !== undefined ? ` · ${fmtInt(provAge)}d ago` : ""}${prov.origin ? ` <span class="dim">· from ${esc(prov.origin)}</span>` : ""}`
        )}
        <p class="kv-note">Date from ${esc(PROVENANCE_LABEL[prov.source])}. Snapshotted at first sighting, because the filesystem evidence behind it decays.</p>
      </section>`
    : "";

  const lifetimeLine = fx?.lifetime
    ? fx.lifetime.invocations > 0
      ? `<p class="lifeline"><b>${fmtInt(fx.lifetime.invocations)}</b> lifetime invocation${fx.lifetime.invocations === 1 ? "" : "s"} across <b>${fmtInt(fx.lifetime.sessions)}</b> session${fx.lifetime.sessions === 1 ? "" : "s"}${fx.trackedSince ? ` since tracking began ${fmtDay(fx.trackedSince)}` : " (tracking start date unavailable)"}` +
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
  const plugin = item.plugin
    ? kv(
        "plugin",
        `${esc(item.plugin.name)} <span class="ver">${esc(item.plugin.version)}</span>` +
          `${item.plugin.latest && item.plugin.latest !== item.plugin.version ? ` <span class="upd">${esc(item.plugin.latest)} listed</span>` : ""}` +
          `${item.plugin.marketplace ? ` <span class="dim">· ${esc(item.plugin.marketplace)}</span>` : ""}`
      )
    : "";

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
        ${plugin}
      </section>
      ${provSection}
      <section>
        <span class="engr">fires</span>
        <p>${fireLine}</p>
        ${lifetimeLine}
        ${projLine}
        ${channelBlock}
        ${readByLine}
        ${providerLines}
        ${outcomeLine}
        ${fx ? weekStrip(fx, w, listed ? w.listingCrossedAt : undefined) : ""}
        ${budgetNote ? `<p class="kv-note">${esc(budgetNote)}</p>` : ""}
        ${collisionBlock}
        ${fireCaveat}
      </section>
      ${evSection}
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
      <button class="btn rescan" data-rescan${state.busy ? " disabled" : ""}>${state.busy ? "scanning…" : "rescan"}</button>
    </div>
  </div>
  <div class="gratbox">${graticule()}${state.animate && state.sweep ? `<div class="sweep"></div>` : ""}</div>
  <div class="readouts">${headerReadouts(payload, state)}</div>
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

export function renderResults(payload: UiPayload, state: AppState): string {
  const shown = payload.items.length === 0 ? 0 : visibleItems(payload, state).length;
  // The denominator is what this MODE could show; the readout names the layer
  // so "54" in skills mode never reads as the whole machine.
  const base = modeBase(payload, state).length;
  return `<div class="tablebox">${table(payload, state)}</div>
  ${logPanel(state)}
  <div class="foot">
    <span class="live"><i></i>127.0.0.1 — local only, nothing leaves the machine</span>
    <span>${fmtInt(shown)} / ${fmtInt(base)} ${state.mode === "skills" ? "skills" : "items"} shown</span>
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
