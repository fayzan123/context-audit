export interface SkillFile {
  /** Path relative to the skill directory. */
  relPath: string;
  absPath: string;
  /** Text content; undefined for binary or oversized files. */
  content?: string;
  bytes: number;
}

export interface Skill {
  /** Directory name — what the harness dispatches on. */
  dirName: string;
  dir: string;
  /** `name:` from frontmatter, if present. */
  fmName?: string;
  description?: string;
  body: string;
  files: SkillFile[];
  hasSkillMd: boolean;
}

export type Level = "flag" | "info";

export interface SecurityFinding {
  skill: string;
  file: string;
  line?: number;
  check: string;
  level: Level;
  message: string;
  /** Verbatim evidence the user can check in ten seconds. */
  evidence: string;
  /** Number of additional files carrying this identical finding (mirrored copies). */
  alsoInFiles?: number;
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
  /** name + description for every skill — injected into every session. */
  alwaysInjectedEst: number;
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
