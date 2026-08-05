import { contentFacts } from "../content.js";
import { securityScan } from "../security.js";
import type { SourceAudit } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { agentsMdAdapter } from "./agentsmd.js";

export const ADAPTERS: SourceAdapter[] = [claudeAdapter, codexAdapter, cursorAdapter, agentsMdAdapter];
export const SOURCE_IDS = ADAPTERS.map((a) => a.id);

export async function auditSource(
  adapter: SourceAdapter,
  ctx: SourceContext,
  opts: { history: boolean; strict: boolean }
): Promise<SourceAudit> {
  const assets = adapter.discover(ctx);
  const audit: SourceAudit = {
    source: adapter.id,
    assets: assets.map((a) => ({ name: a.dirName, kind: a.kind ?? "skill", path: a.dir })),
    content: contentFacts(assets),
    security: securityScan(assets, opts.strict),
  };
  if (opts.history && adapter.usage && assets.length > 0) {
    audit.history = await adapter.usage(ctx, assets);
  }
  const caveats = adapter.caveats?.(ctx) ?? [];
  if (caveats.length > 0) audit.caveats = caveats;
  return audit;
}

export type { SourceAdapter, SourceContext } from "./types.js";
