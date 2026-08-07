export interface SkillFile {
  /** Path relative to the skill directory. */
  relPath: string;
  absPath: string;
  /** Text content; undefined for binary files. */
  content?: string;
  bytes: number;
  /** Content is only the first MAX_FILE_BYTES — the tail was not scanned. */
  truncated?: boolean;
  /** A directory that was recorded but never walked (node_modules and friends). */
  skippedDir?: boolean;
  /**
   * Inside a published third-party package (a vendored directory carrying its
   * own manifest). Recorded and counted, but not read: reviewing dependency
   * source is `npm audit`'s job. A file in a vendored tree with NO manifest is
   * not this — it gets scanned normally, because that is where a payload hides.
   */
  vendorPackage?: boolean;
  /**
   * Git's own compressed object storage (a loose object or a packfile), which
   * carries no readable payload. Recorded rather than skipped: "skip anything
   * with this name shape" was itself a hiding place, so the shape now only
   * decides how the bytes are *reported*, never whether they are read.
   */
  gitObject?: boolean;
  /**
   * A symlink that resolves outside its asset's containment root (plugin trees
   * only). Recorded with its real target and NOT followed — reported as a
   * finding, because a third-party package reaching out of its own install is
   * the fact worth knowing, and silently skipping it would make the boundary a
   * hiding place.
   */
  escapedTo?: string;
}

/** Which tool's configuration an asset belongs to. */
export type SourceId = "claude" | "codex" | "cursor" | "agents-md" | "custom";

/** What the asset is to its harness — decides which checks and costs apply. */
export type AssetKind = "skill" | "agent" | "command" | "prompt" | "rule" | "instructions";

/**
 * What part of an asset its harness keeps in context at all times. This is the
 * cost model: a Claude skill pays its name + description every session; an
 * `alwaysApply` Cursor rule or an AGENTS.md pays its whole BODY every session;
 * a Codex prompt pays only its name; a glob-scoped rule pays nothing until it
 * triggers.
 */
export type Injection = "body" | "description" | "name-only" | "on-demand";

export interface Skill {
  /** Dispatch name — what the harness matches on (directory, filename, or `name:`). */
  dirName: string;
  dir: string;
  /** `name:` from frontmatter, if present. */
  fmName?: string;
  description?: string;
  body: string;
  files: SkillFile[];
  hasSkillMd: boolean;
  /** Undefined means "claude-format skill" — the original single-source shape. */
  source?: SourceId;
  kind?: AssetKind;
  injection?: Injection;
  /**
   * Shipped by an installed plugin rather than written by the user. The CLI
   * discovers these so its cost and usage figures cover what Claude Code
   * actually loads; the dashboard discovers them separately (it needs each
   * install's version and marketplace for grouping), so it uses this flag to
   * skip the adapter's copies rather than counting every plugin asset twice.
   */
  fromPlugin?: boolean;
}

export type Level = "flag" | "info";

/** How bad it is if real. */
export type Severity = "critical" | "high" | "medium" | "low";

/**
 * How likely this is a true positive, held separately from severity — the
 * distinction npm audit lacks and that trained an ecosystem to ignore it.
 * `certain`: structural, no legitimate use (invisible unicode, decoded payload).
 * `likely`: strong pattern with a plausible benign explanation.
 * `possible`: worth a look; benign in most codebases.
 */
export type Confidence = "certain" | "likely" | "possible";

export interface SecurityFinding {
  skill: string;
  file: string;
  /**
   * Absolute path to the cited file. The report tells its reader to verify every
   * flag at the cited line before acting on it, and `skill` + a skill-relative
   * `file` made that a join the reader had to perform — which is exactly where a
   * verifying agent went to the wrong file and reported two nonexistent bugs.
   * The path it should open is now stated outright.
   */
  path?: string;
  line?: number;
  check: string;
  level: Level;
  severity: Severity;
  confidence: Confidence;
  message: string;
  /** Verbatim evidence the user can check in ten seconds. */
  evidence: string;
  /** Number of additional files carrying this identical finding (mirrored copies). */
  alsoInFiles?: number;
  /**
   * The finding is inside a vendored dependency tree rather than in code the
   * skill author wrote. Reported, but never allowed to gate the exit code —
   * third-party dependency review is `npm audit`'s job, and letting a library's
   * sourcemaps and test fixtures fail this build is how a gate gets ignored.
   */
  vendored?: boolean;
}

export interface ContentFacts {
  skillCount: number;
  emptyDescriptions: string[];
  duplicateDescriptions: { description: string; skills: string[] }[];
  nameMismatches: { skill: string; fmName: string }[];
  missingSkillMd: string[];
  /** chars/4 estimates, labeled as such in output. */
  tokens: { skill: string; bodyEst: number; descriptionEst: number }[];
  totalBodyEst: number;
  /** Everything the harness keeps in context at all times, per the Injection model. */
  alwaysInjectedEst: number;
  /** The same figure in characters. */
  alwaysInjectedChars: number;
  /**
   * Characters of skill names + descriptions only — the slice Claude Code
   * budgets in characters (`skillListingBudgetFraction`, ~1% of the context
   * window). Instruction-file bodies are always injected but do NOT count
   * against that listing budget, so the two figures are held apart.
   */
  listingChars: number;
}

export interface SkillUsage {
  skill: string;
  invocations: number;
  sessions: number;
  /**
   * Oldest invocation in the scanned window. Held alongside `lastFired`
   * because the pair is what tells a reader whether a skill was used
   * throughout the window or only at the very start of it — and because the
   * window is a transcript-RETENTION window, not the life of the machine.
   */
  firstFired?: string;
  lastFired?: string;
  interruptedAfter: number;
  /**
   * The asset kind this row's fires resolved to, decided per dispatch channel
   * (a Skill tool_use is evidence for "skill", a typed command for "command").
   * Lets a name installed as both a skill and a command keep two honest rows
   * instead of one kind silently absorbing the other's fires.
   */
  kind?: AssetKind;
}

// --- usage ledger ---------------------------------------------------------
// Durable invocation history under ~/.context-audit/usage — what survives the
// harness's transcript purge. Events carry names, timestamps, paths and ids
// ONLY: never message content, prompt text, or skill args.

/** How the invocation happened: model-dispatched, user-typed, or a passive file load. */
export type LedgerChannel = "auto" | "typed" | "load";

/** Whether the launch itself succeeded — absent where the source doesn't say. */
export type LedgerOutcome = "ok" | "error" | "rejected";

export interface LedgerEvent {
  /** Event schema version. */
  v: number;
  /** Dedupe key — scan ingestion and hooks derive the same id, so double-capture collapses. */
  id: string;
  /** ISO-8601. Also selects the monthly ledger file the event is stored in. */
  ts: string;
  /**
   * The harness that dispatched or loaded the asset — never "agents-md": an
   * AGENTS.md load is recorded against the provider that READ the file (e.g.
   * codex), one event per reader.
   */
  provider: SourceId;
  kind: AssetKind;
  /** Dispatch name exactly as the harness used it. */
  name: string;
  channel: LedgerChannel;
  outcome?: LedgerOutcome;
  interrupted?: boolean;
  sessionId: string;
  /** Absolute cwd the session ran in. */
  project: string;
  /** Subagent attribution when the fire happened inside a sidechain. */
  agent?: { id: string; type: string };
  model?: string;
  /** "cli" vs "sdk-cli" — separates interactive use from automation. */
  entrypoint?: string;
  caller?: string;
  /** Transcript file + line the event was read from — the drill-down's proof pointer. */
  src?: { file: string; line: number };
  /** Imported from history.jsonl rather than observed in a transcript — typed channel only. */
  backfill?: boolean;
  /** Written by a real-time hook rather than derived from a transcript scan. */
  hook?: boolean;
}

/**
 * Claude Code's own slash commands. They say nothing about the user's
 * instruction inventory — they can never join to a row — and one of them (a
 * `/usage` poller) accounted for 2,594 of 3,179 observed typed entries on the
 * reference machine. Held here rather than in any one writer because all THREE
 * typed-channel writers (transcript ingestion, hooks, backfill) must agree:
 * a token dropped by one writer and banked by another is the same fire
 * counted differently depending on which channel saw it first.
 */
export const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  "usage", "status", "model", "exit", "clear", "compact", "effort", "login",
  "config", "context", "resume", "continue", "mcp", "doctor", "permissions",
  "plugins", "plugin", "voice", "rate-limit-options",
]);

/** Which rung of the install-date fallback chain produced the date. */
export type ProvenanceSource = "plugin-manifest" | "birthtime" | "git" | "mtime" | "first-seen";

/**
 * Install-date snapshot, captured at first sighting because the filesystem
 * evidence decays (plugin caches get pruned, transcripts get deleted).
 */
export interface Provenance {
  /** ISO-8601. A "mtime" date is a last edit, and the UI labels it as such. */
  installedAt: string;
  source: ProvenanceSource;
  /** Marketplace or plugin the item arrived from, when known. */
  origin?: string;
}

export interface HistoryFacts {
  transcriptFiles: number;
  windowStart?: string;
  windowEnd?: string;
  usage: SkillUsage[];
  neverFired: string[];
  /** Invocations of skills not present in the audited directory (plugins, removed skills). */
  external: SkillUsage[];
  /**
   * Ledger-shaped events behind `usage` — what scan-time ingestion appends to
   * the durable store. Absent until the adapter's usage() pass emits them.
   */
  events?: LedgerEvent[];
  /**
   * Read tool_use paths observed inside a tracked asset's own directory —
   * "does this skill's bundled reference actually get read when it runs?".
   * `dir` is the asset root the path fell under; sessions are the sessions the
   * read happened in, so the join can express it as a share of that asset's
   * fires rather than a bare count.
   */
  fileReads?: { dir: string; relPath: string; sessions: string[] }[];
  /**
   * Total tokens observed in each dedicated `subagents/agent-<id>.jsonl`
   * transcript. Per-AGENT run cost is near-exact because the agent's work
   * lives in a file of its own — the confound that keeps per-skill cost out
   * of this tool does not apply here.
   */
  agentRuns?: { agentId: string; tokens: number }[];
}

export interface AuditResult {
  dir: string;
  content: ContentFacts;
  security: SecurityFinding[];
  history?: HistoryFacts;
}

export interface AssetSummary {
  name: string;
  kind: AssetKind;
  path: string;
}

/** One tool's complete audit: what was found, what it costs, what fired. */
export interface SourceAudit {
  source: SourceId;
  assets: AssetSummary[];
  content: ContentFacts;
  security: SecurityFinding[];
  /** Absent when the tool keeps no parseable local transcripts — never fabricated. */
  history?: HistoryFacts;
  /** Qualifiers on this source's figures — see SourceAdapter.caveats. */
  caveats?: string[];
}

export interface MultiAuditResult {
  sources: SourceAudit[];
}

// --- ui dashboard payload -------------------------------------------------
// One JSON shape, produced server-side and consumed by the browser. Data flow
// is one-way: disk → audit engine → this payload → browser. The browser sends
// back only item IDs and the session token, never paths.

/**
 * One drill-down row. Browser-bound, so it carries NO filesystem paths — the
 * server resolves the transcript location from the event id.
 */
export interface UiFireEvent {
  id: string;
  ts: string;
  /** Project display name, never the absolute path. */
  project: string;
  channel: LedgerChannel;
  outcome?: LedgerOutcome;
  interrupted?: boolean;
  /**
   * The transcript behind this event was already purged at scan time. The row
   * still renders — the ledger entry is the durable record — but its open
   * affordance is disabled up front instead of after a dead round-trip.
   */
  purged?: boolean;
  /**
   * Imported from history.jsonl — no transcript ever existed behind this row,
   * so it is labeled as an import and carries no open affordance.
   */
  backfill?: boolean;
}

/** Fire history for one item. `null` on an item means "tracked, never fired". */
export interface UiFires {
  invocations: number;
  sessions: number;
  firstFired?: string;
  lastFired?: string;
  interruptedAfter: number;
  // Everything below comes from the durable ledger and is absent until the
  // ledger join runs; the fields above stay scoped to the transcript window,
  // and the two windows are never conflated.
  /** Counts since `trackedSince` — the qualifier every lifetime figure carries. */
  lifetime?: { invocations: number; sessions: number; firstFired?: string; lastFired?: string };
  /** ISO date tracking began: ledger meta, or the backfill horizon where backfill ran. */
  trackedSince?: string;
  /** Model-dispatched vs user-typed fires, lifetime. */
  byChannel?: { auto: number; typed: number };
  /** Lifetime fires per provider, for assets read by more than one harness. */
  byProvider?: Partial<Record<SourceId, number>>;
  /** Lifetime fires per project display name, descending — never the path. */
  byProject?: { name: string; count: number }[];
  /** Lifetime fires split by recorded launch result. */
  outcomes?: { ok: number; error: number; rejected: number };
  /** Fires bucketed by ISO week start — the trend strip's data. */
  weeklyBins?: { weekStart: string; count: number }[];
  /** Reverse-chron drill-down, capped server-side ("show all N" pages further). */
  events?: UiFireEvent[];
  /**
   * Interactive (`entrypoint: "cli"`) vs automated (`sdk-cli` and friends).
   * `unknown` is its own bucket, never folded into either: most banked events
   * carry no entrypoint at all, and calling those "interactive" would invent
   * the very split this answers.
   */
  byEntrypoint?: { interactive: number; automated: number; unknown: number };
  /** Fires in the main agent vs inside a subagent sidechain. */
  byAgent?: { main: number; sidechain: number };
  /** Lifetime fires per dispatching model, descending. Absent when unrecorded. */
  byModel?: { model: string; count: number }[];
  /**
   * The current silence measured against THIS item's own rhythm — a 34-day
   * gap means nothing until you know its longest previous gap was 12. Absent
   * for items with fewer than two fires, where no gap exists to compare to.
   */
  quiet?: { days: number; longestPriorGapDays?: number; gapsCounted: number };
  /**
   * Staple or one-burst: distinct weeks with a fire, weeks since the first
   * fire, and the flag for "every fire landed inside one 7-day span".
   */
  spread?: { activeWeeks: number; weeksSinceFirst: number; spanDays: number; oneBurst: boolean };
  /**
   * Fires either side of the plugin update boundary over SYMMETRIC windows —
   * "since update (12d): 0 · prior 12d: 9". Asymmetric windows would compare a
   * fortnight against a lifetime and call the difference a change.
   */
  sinceUpdate?: { at: string; days: number; since: number; prior: number };
  /**
   * Days from the provenance install date to the first recorded fire. Present
   * only when the install date falls INSIDE observable history — otherwise the
   * first fire on record is just the horizon, not the first fire that happened.
   */
  installToFirstFire?: number;
}

export interface UiPluginMeta {
  /** Plugin name, e.g. "superpowers". */
  name: string;
  marketplace?: string;
  /** The version actually resolved as active — the one whose files are audited. */
  version: string;
  /**
   * Newest version the local marketplace checkout lists, when that can be
   * determined without touching the network. Absent means "unknown", which is
   * not the same claim as "up to date".
   */
  latest?: string;
  /** Manifest `installedAt` — when this plugin first arrived. */
  installedAt?: string;
  /**
   * Manifest `lastUpdated` — "current version since", NOT an install date. The
   * boundary a skill's fires are compared across.
   */
  lastUpdated?: string;
}

/**
 * A plugin version still on disk that nothing resolves to any more. Reported
 * with its paths and never deleted: this tool measures, it does not clean up.
 */
export interface UiSuperseded {
  plugin: string;
  marketplace?: string;
  /** The version actually live — the one these are superseded BY. */
  active: string;
  versions: string[];
  bytes: number;
  paths: string[];
}

export interface UiItem {
  /**
   * Stable identity: hash of source + kind + path. All mutating requests
   * reference this ID; the server resolves it to a path from its own
   * inventory, so a client-supplied path is never accepted anywhere.
   */
  id: string;
  name: string;
  source: SourceId;
  kind: AssetKind;
  path: string;
  /** User-level (~) vs project-level (cwd) — the adapters scan both. */
  scope: "user" | "project";
  /** False for ~/.claude/skills-disabled items and disabled plugins. */
  enabled: boolean;
  /** True only where a safe convention exists: Claude user skills. */
  togglable: boolean;
  /** Why the toggle is absent, shown as the tooltip on read-only rows. */
  readOnlyReason?: string;
  plugin?: UiPluginMeta;
  description?: string;
  frontmatter?: Record<string, string>;
  injection: Injection;
  /**
   * Characters this item keeps in context at all times while enabled. Stated
   * per-item even on disabled rows (it is what re-enabling would cost); the
   * header total sums enabled items only.
   */
  injectedChars: number;
  bodyChars: number;
  /**
   * Fire history: an object when the item fired, null when its kind is
   * dispatch-tracked but never fired, absent when the tool keeps no readable
   * local history ("n/a", rendered honestly rather than as a zero).
   */
  fires?: UiFires | null;
  findings: SecurityFinding[];
  /** The engine could not fully parse this item (no readable entry file). */
  parseError?: boolean;
  /**
   * Absolute path of this skill's other copy when the same name sits in both
   * `~/.claude/skills` and `~/.claude/skills-disabled`. Set on both rows —
   * `enabled` says which side this row is. The disabled side is shadowed: it
   * can never dispatch and cannot be re-enabled while the twin exists, and
   * fire history (keyed by dispatch name) is attributed to the enabled copy
   * only.
   */
  twinPath?: string;
  /** Install date and which evidence chain produced it — see the provenance store. */
  provenance?: Provenance;
  /** Providers observed loading this asset (an AGENTS.md read by codex, …). */
  readBy?: SourceId[];
  /**
   * Exact dispatch-name copies at other scopes. No transcript evidence can
   * split fires between them, so counts on both rows carry this warning.
   */
  collision?: { paths: string[] };
  /**
   * Latest edit across the asset's files, and the fires recorded after it.
   * Reads in both directions from the same two inputs: "edited 5d ago — 2
   * fires since" and "unchanged 187d · 41 fires in that span".
   */
  freshness?: { editedAt: string; days: number; firesSince: number; source: "git" | "mtime" };
  /**
   * Paths the entry file names that do not resolve, and scripts it points at
   * that carry no exec bit. Line numbers are SKILL.md's, so the reader can go
   * look. `checked` is the denominator — 0 missing of 0 checked is not a
   * clean bill of health.
   */
  refs?: {
    checked: number;
    missing: { path: string; line: number }[];
    notExecutable: { path: string; line: number }[];
  };
  /**
   * The same dispatch name present under ANOTHER provider — a Claude skill
   * that also exists as a Codex one. `identical` is a body hash comparison,
   * not a guess. Cross-linked by item id; the browser never gets a path it
   * did not already have.
   */
  crossProvider?: { itemId: string; source: SourceId; name: string; identical: boolean }[];
  /**
   * Items whose description is byte-identical to this one after whitespace
   * folding — the dispatch-confusion set, now carrying each member's fire
   * count so "which twin is winning" is a fact rather than a suspicion.
   */
  confusable?: { itemId: string; name: string; fires: number }[];
  /** Sessions in which this item AND one of its confusable twins both fired. */
  coFiredSessions?: number;
  /**
   * Dispatch names that fired but match nothing installed, and that look like
   * typos of THIS item's name (edit distance ≤ 2, or a shared prefix).
   */
  nearMiss?: { name: string; count: number }[];
  /**
   * Scope mismatch facts: a user-scoped item every one of whose fires landed
   * in a single project, and/or the same name present at the other scope.
   */
  scopeNote?: { allFiresIn?: string; alsoAtScope?: "user" | "project" };
  /**
   * Files bundled beside the entry file and how many of this item's fires
   * read them (Read tool_use paths under the asset's directory, in the same
   * sessions). `ofFires` is the denominator the share is taken over.
   */
  bundledFiles?: { relPath: string; readInFires: number; ofFires: number }[];
  /**
   * Whether a newer CACHED plugin version would change this item's files at
   * all — a byte comparison across version directories, not a version-number
   * inference. Absent when no other version is on disk to compare against.
   */
  updateRelevance?: { version: string; identical: boolean; changedFiles?: number };
  /**
   * Was disabling safe? Attempted invocations of this dispatch name since it
   * was disabled, and the other assets whose bodies name it.
   *
   * `disabledAtSource` names the evidence, because there is no disable log:
   * moving a skill into `skills-disabled/` is a rename, which leaves mtime
   * alone but bumps ctime — so ctime is an UPPER BOUND that anything else
   * touching the directory's metadata moves too. An unlabeled "disabled 122d
   * ago" would present that bound as a record (invariant 6).
   */
  disabledSafety?: {
    disabledAt?: string;
    disabledAtSource?: "ctime";
    days?: number;
    attemptsSince: number;
    referencedBy: string[];
  };
  /**
   * Per-agent run cost, summed from the agent's OWN dedicated
   * `subagents/agent-<id>.jsonl` transcripts — near-exact, unlike per-skill
   * cost, because the agent's work lives in a file of its own. Labeled with
   * that method wherever it renders.
   */
  agentCost?: { runs: number; totalTokens: number; medianTokens: number };
}

/**
 * The Claude Code skill-listing budget and where this setup sits against it.
 * Absent when nothing on the machine is subject to it (no Claude skills).
 */
export interface ListingBudget {
  chars: number;
  budgetChars: number;
  pct: number;
  /** Decided on raw characters, never on the rounded percentage. */
  over: boolean;
  /**
   * When snapshots record the listing crossing from under to over budget,
   * the ts of the first over-budget snapshot after the latest under-budget
   * one — the onset a quiet skill's trend can be read against. Absent when
   * no crossing is recorded.
   */
  crossedAt?: string;
}

/**
 * Does the whole system earn its rent? Portfolio facts computed in one ledger
 * pass, each carrying the denominator that keeps it honest.
 */
export interface UiPortfolio {
  /** Sessions with at least one recorded fire of any tracked item. */
  sessionsWithFires: number;
  /** The denominator: sessions the ledger has seen at all. */
  sessions: number;
  /**
   * The fewest items whose fires make up ≥80% of all recorded fires — the
   * "3 skills account for 84% of fires" fact, with the ids behind it so the
   * stat can open its own proof view.
   */
  concentration?: { items: number; pct: number; ids: string[] };
  /** Top items by window spend: always-in-context chars × sessions. */
  topSpend: { id: string; name: string; chars: number }[];
  /**
   * Flagged items ordered by activity, fired partition first — a flag on
   * something that runs daily outranks a flag on a dormant file.
   */
  flaggedByActivity: { id: string; name: string; fires: number; lastFired?: string; projects: number }[];
}

/** What changed since the previous scan — a snapshots.jsonl diff, not a guess. */
export interface UiDelta {
  /** The snapshot this delta is measured against. */
  since: string;
  items: number;
  injectedChars: number;
  /**
   * Plugins whose resolved version moved between the two snapshots.
   *
   * `from` is OPTIONAL because nothing on disk records it: snapshots carry no
   * plugin versions, and the cache cannot prove which of its superseded
   * directories was the live one. Absent means "it updated, and the previous
   * version was not recorded" — which the UI must say in those words rather
   * than printing a sentinel that reads like a version.
   */
  pluginsUpdated: { name: string; from?: string; to: string }[];
}

/**
 * The modeled listing cut line. Claude Code drops descriptions starting with
 * the least-invoked skills, so this replays that documented drop order over
 * the real listing and names which rows fall off the end.
 */
export interface UiBudgetCut {
  budgetChars: number;
  listingChars: number;
  /**
   * Every listed skill in KEEP order (most-fired first): the ones that fit
   * come first, the dropped tail last. `cumChars` is the running total the
   * cut is decided on.
   */
  order: { id: string; name: string; chars: number; fires: number; cumChars: number; dropped: boolean }[];
  /** Characters that must go for the whole listing to fit. 0 when under budget. */
  headroomChars: number;
}

/**
 * Is the pile outgrowing its use? Two series over ISO weeks, each captioned
 * with the source it came from — owned counts are snapshot observations
 * (absent before tracking began), fired counts are ledger events.
 */
export interface UiGrowth {
  weeks: { weekStart: string; owned?: number; firedItems: number }[];
  /** Names the method behind `owned`, rendered as the series caption. */
  ownedSource: string;
}

/** The pitch in five numbers, plus the denominators that keep them honest. */
export interface UiHeader {
  items: number;
  providers: number;
  /**
   * Claude's skill listing, when this machine has one. Counts every ENABLED
   * skill whose description loads — user, project and plugin alike — because
   * that is what Claude Code reads.
   */
  listing?: ListingBudget;
  /** Enabled items only — what the setup actually costs per session. */
  injectedChars: number;
  injectedTokens: number;
  neverFired: number;
  /** How many items have fire tracking at all — the neverFired denominator. */
  tracked: number;
  /**
   * Dead-weight rent: Σ injectedChars over enabled, age-gated, never-fired
   * items — a PER-SESSION figure, which is how the header renders it ("~Nk
   * tok/session on silent items"). Multiplying by a session count would state
   * a window total, a different unit that must never sit unlabeled beside
   * this one. Absent until the ledger join computes it.
   */
  deadWeightChars?: number;
  flagged: number;
  flaggedHigh: number;
}

export interface UiPayload {
  version: string;
  generatedAt: string;
  tookMs: number;
  /** What was audited: "~ + <cwd>" in detect mode, the directory in dir mode. */
  root: string;
  header: UiHeader;
  items: UiItem[];
  history?: {
    transcriptFiles: number;
    windowStart?: string;
    windowEnd?: string;
    /**
     * Oldest backfilled (history.jsonl-imported) event — the typed channel
     * reaches back this far, further than any surviving transcript. Absent
     * when no backfill ran.
     */
    backfilledSince?: string;
  };
  /**
   * How active plugin versions were resolved: from the plugin config, or by
   * newest-version-per-plugin when the config was unreadable (shown as a
   * caveat in the UI — degraded, never dropped).
   */
  pluginResolution?: "config" | "newest-fallback";
  /**
   * The durable ledger could not be opened for this scan: lifetime figures,
   * provenance and dead-weight are absent, window figures stand alone. Shown
   * as a caveat, never silently.
   */
  ledgerCaveat?: string;
  /**
   * Qualifiers on this payload's figures that are not tied to one item — a
   * provider whose local store could not be read, an undocumented schema that
   * changed shape. Rendered in the rail beside the ledger caveat; degraded is
   * always stated, never silent.
   */
  caveats?: string[];
  /**
   * Each provider's OWN observation window, held apart from the merged
   * `history` window above. Retention differs per harness — Claude Code purges
   * transcripts on a ~30-day cycle while Codex rollouts reach back months and
   * the Cursor store is dated per conversation — so a single window date
   * cannot honestly caption a cross-provider comparison. The overlap matrix
   * puts these in its column heads for exactly that reason.
   */
  providerWindows?: Partial<Record<SourceId, { start?: string; end?: string }>>;
  /** Portfolio rollup — absent when no ledger backs it. */
  portfolio?: UiPortfolio;
  /** Since-last-scan delta — absent on the first scan, which has no baseline. */
  delta?: UiDelta;
  /** The listing budget's modeled drop order — absent where no listing applies. */
  budgetCut?: UiBudgetCut;
  /** Owned-vs-used over time — absent until snapshots or fires exist to plot. */
  growth?: UiGrowth;
  /** Plugin versions still on disk that nothing resolves to. */
  superseded?: UiSuperseded[];
}
