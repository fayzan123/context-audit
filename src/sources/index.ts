import { join } from "node:path";
import { contentFacts } from "../content.js";
import { openLedger, type Ledger } from "../ledger.js";
import { securityScan } from "../security.js";
import type { SourceAudit } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { agentsMdAdapter } from "./agentsmd.js";

export const ADAPTERS: SourceAdapter[] = [claudeAdapter, codexAdapter, cursorAdapter, agentsMdAdapter];
export const SOURCE_IDS = ADAPTERS.map((a) => a.id);

/**
 * SourceContext plus the ledger location. Held beside the audit entrypoints
 * rather than on SourceContext itself because adapters never touch the ledger
 * — only the scan wiring does. Tests point it at a mkdtemp dir.
 */
export interface AuditContext extends SourceContext {
  ledgerHome?: string;
}

/**
 * Where this scan's ledger lives: explicit override > CONTEXT_AUDIT_HOME >
 * `<ctx.home>/.context-audit`. Derived from ctx.home rather than the real
 * homedir so a test scanning a fabricated HOME banks into a fabricated ledger
 * — never the machine's real one.
 */
export function scanLedgerHome(ctx: AuditContext): string {
  return ctx.ledgerHome ?? process.env.CONTEXT_AUDIT_HOME ?? join(ctx.home, ".context-audit");
}

export async function auditSource(
  adapter: SourceAdapter,
  ctx: AuditContext,
  opts: { history: boolean; strict: boolean; ledger?: Ledger }
): Promise<SourceAudit> {
  const assets = adapter.discover(ctx);
  const audit: SourceAudit = {
    source: adapter.id,
    assets: assets.map((a) => ({ name: a.dirName, kind: a.kind ?? "skill", path: a.dir })),
    content: contentFacts(assets),
    security: securityScan(assets, opts.strict),
  };
  const caveats = adapter.caveats?.(ctx) ?? [];
  if (opts.history && adapter.usage && assets.length > 0) {
    audit.history = await adapter.usage(ctx, assets);
    const events = audit.history.events ?? [];
    if (events.length > 0) {
      // Bank the visible window before the harness purges it. An unwritable
      // ledger degrades to the transcript-only figures the audit always had —
      // and says so — rather than failing the scan.
      try {
        // The caller's ledger when it opened one (one parse per CLI run,
        // not one per adapter); otherwise open here as before.
        const ledger = opts.ledger ?? openLedger(scanLedgerHome(ctx));
        // A session whose typed commands the hooks already captured belongs
        // to the hook: the scan's copies of those events carry a different
        // clock in their ids, so banking them would double-count every typed
        // command — the session-level exclusion mirrors the backfill rule.
        const hookTypedSessions = new Set(
          ledger.readEvents()
            .filter((e) => e.hook === true && e.channel === "typed")
            .map((e) => e.sessionId)
        );
        ledger.appendEvents(
          events.filter(
            (e) => !(e.provider === "claude" && e.channel === "typed" && !e.hook && hookTypedSessions.has(e.sessionId))
          )
        );
      } catch (err) {
        const why = String((err as Error)?.message ?? err).slice(0, 120);
        caveats.push(
          `usage ledger unavailable (${why}) — this run's events were not banked; ` +
            `usage figures reflect the current transcript window only`
        );
      }
    }
  }
  if (caveats.length > 0) audit.caveats = caveats;
  return audit;
}

export type { SourceAdapter, SourceContext } from "./types.js";
