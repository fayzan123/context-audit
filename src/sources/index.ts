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
    // The scan reaches wider than the inventory, and only in this direction: a
    // file that is not an asset costs nothing and can never fire, so it belongs
    // in no count — but it is still a file in a directory the model's harness
    // walks, and leaving it unread would make "not counted" mean "not looked
    // at". See SourceAdapter.scanOnly.
    security: securityScan([...assets, ...(adapter.scanOnly?.(ctx) ?? [])], opts.strict),
  };
  // Ledger-banking failures are collected here rather than pushed onto the
  // adapter's own caveats, because caveats() cannot be called until after
  // usage() has run (see the call site below) and this failure happens first.
  const banking: string[] = [];
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
        //
        // The key carries the provider, and the predicate below therefore names
        // no provider of its own. Ownership is per-provider by construction: a
        // Claude hook watches a Claude session and says nothing about what a
        // Codex rollout recorded, and two harnesses hand out session ids of the
        // same shape, so a bare id both suppresses fires it never observed and
        // — the failure that matters now that `hooks install --provider codex`
        // ships — lets a Codex rollout's typed prompt bank NEXT TO the Codex
        // hook's own event for it, double-counting every Codex prompt.
        const hookTypedSessions = new Set(
          ledger.readEvents()
            .filter((e) => e.hook === true && e.channel === "typed")
            .map((e) => `${e.provider}:${e.sessionId}`)
        );
        ledger.appendEvents(
          events.filter(
            (e) => !(e.channel === "typed" && !e.hook && hookTypedSessions.has(`${e.provider}:${e.sessionId}`))
          )
        );
      } catch (err) {
        const why = String((err as Error)?.message ?? err).slice(0, 120);
        banking.push(
          `usage ledger unavailable (${why}) — this run's events were not banked; ` +
            `usage figures reflect the current transcript window only`
        );
      }
    }
  }
  // Asked only AFTER usage() has run. The cursor adapter's caveats() reports
  // the memoized outcome of its own store read — which failure made the store
  // unreadable, how many records carried no name, how many attachments were
  // undated — and that read is async, so a synchronous hook can only report it
  // once it has happened. Asked first, cursor returned its two static labels
  // and the real read outcome never reached the report at all. The claude and
  // codex hooks read only the filesystem, so the later call changes nothing
  // for them.
  const caveats = [...(adapter.caveats?.(ctx) ?? []), ...banking];
  if (caveats.length > 0) audit.caveats = caveats;
  return audit;
}

export type { SourceAdapter, SourceContext } from "./types.js";
