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
  lastFired?: string;
  interruptedAfter: number;
}

export interface HistoryFacts {
  transcriptFiles: number;
  windowStart?: string;
  windowEnd?: string;
  usage: SkillUsage[];
  neverFired: string[];
  /** Invocations of skills not present in the audited directory (plugins, removed skills). */
  external: SkillUsage[];
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
}

export interface MultiAuditResult {
  sources: SourceAudit[];
}
