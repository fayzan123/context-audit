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
  usage?(ctx: SourceContext, assets: Skill[]): Promise<HistoryFacts>;
  /**
   * Anything that qualifies this source's numbers — a degraded resolution, a
   * guess the report would otherwise present as a measurement. Printed next to
   * the figures they affect. A tool that had to guess says so.
   */
  caveats?(ctx: SourceContext): string[];
}
