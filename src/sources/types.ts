import type { HistoryFacts, Skill, SourceId } from "../types.js";

/**
 * Where a source adapter is allowed to look. Passed in rather than read from
 * the environment so the whole discovery layer is testable against a
 * fabricated HOME and project directory.
 */
export interface SourceContext {
  home: string;
  cwd: string;
  /** Claude transcript override (--transcripts). */
  transcripts?: string;
}

/**
 * One tool's integration: where its instruction assets live, how to parse
 * them, and — only where the tool actually keeps local transcripts — how to
 * read usage. `usage` is deliberately optional: a tool without parseable
 * history gets no usage section rather than a fabricated one.
 */
export interface SourceAdapter {
  id: SourceId;
  detect(ctx: SourceContext): boolean;
  discover(ctx: SourceContext): Skill[];
  /**
   * Files inside this source's directories that are NOT assets — nothing loads
   * them, they cost nothing, they can never fire — but that the security engine
   * must still read. `~/.claude/agents/README.md` is the case: it has no
   * frontmatter name, so Claude Code cannot register it and counting it as an
   * agent inflated the inventory and the never-fired total. Dropping it from
   * discovery without this list would turn the directory into a hiding place
   * for an injection payload nothing ever reads, which is the one thing this
   * tool must never do. Cost and usage never see these; the scanner always does.
   */
  scanOnly?(ctx: SourceContext): Skill[];
  usage?(ctx: SourceContext, assets: Skill[]): Promise<HistoryFacts>;
  /**
   * Anything that qualifies this source's numbers — a degraded resolution, a
   * guess the report would otherwise present as a measurement. Printed next to
   * the figures they affect. A tool that had to guess says so.
   */
  caveats?(ctx: SourceContext): string[];
}
