import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TYPED_TOKEN_RE } from "./ledger.js";
import type { Ledger } from "./ledger.js";
import { BUILTIN_COMMANDS } from "./types.js";
import type { LedgerEvent } from "./types.js";

/**
 * One ~/.claude/history.jsonl line, which survives the transcript purge for
 * months and recovers the typed channel only. `pastedContents` can hold
 * pasted file bodies — it is never read, and nothing but the dispatch token
 * ever reaches the ledger.
 */
interface HistoryEntry {
  display: string;
  /** Epoch milliseconds. */
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface BackfillInventory {
  /** Skill dispatch names, no leading slash — matches import as kind "skill". */
  skills: ReadonlySet<string>;
  /** Command dispatch names — matches import as kind "command". */
  commands: ReadonlySet<string>;
}

export interface BackfillOptions {
  /**
   * Set the ledger's DURABLE built-ins preference before importing (leaving it
   * alone when absent). The import itself no longer decides: a flag on this one
   * command could never reach a hook firing inside someone else's session, so
   * the answer is stored and every typed-channel writer reads it back.
   */
  includeBuiltins?: boolean;
}

export interface BackfillResult {
  /** Events actually appended — a re-run reports 0, not the batch size. */
  imported: number;
  /** Refused by the ledger's built-ins preference — see BackfillOptions. */
  droppedBuiltins: number;
  droppedPollerSessions: number;
  /** Distinct names matching nothing in the inventory — imported anyway, with no join. */
  unresolved: string[];
}

interface SessionBucket {
  tokens: { name: string; builtin: boolean; ts: string; project: string; line: number }[];
  entries: number;
  builtinEntries: number;
}

export function runBackfill(
  home: string,
  ledger: Ledger,
  inventoryNames: BackfillInventory,
  opts?: BackfillOptions
): BackfillResult {
  const result: BackfillResult = { imported: 0, droppedBuiltins: 0, droppedPollerSessions: 0, unresolved: [] };
  // Recorded before the import so this run is governed by the answer it just
  // stored, not by the previous one.
  if (opts?.includeBuiltins !== undefined) ledger.setIncludeBuiltins(opts.includeBuiltins);
  const file = join(home, ".claude", "history.jsonl");
  if (!existsSync(file)) return result;

  // Sessions that produced any transcript-derived event are skipped whole:
  // their typed channel was already captured exactly, and an absent-vs-present
  // sessionId test needs no timestamp-tolerance matching.
  const captured = new Set<string>();
  for (const e of ledger.readEvents()) if (!e.backfill) captured.add(e.sessionId);

  const sessions = new Map<string, SessionBucket>();
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let entry: HistoryEntry;
    try {
      entry = JSON.parse(lines[i]) as HistoryEntry;
    } catch {
      continue;
    }
    if (
      typeof entry?.display !== "string" ||
      !Number.isFinite(entry.timestamp) ||
      typeof entry.project !== "string" ||
      typeof entry.sessionId !== "string" ||
      entry.sessionId.length === 0
    )
      continue;
    // Number.isFinite admits epochs outside Date's representable ±8.64e15 ms,
    // where toISOString() throws — one torn write must not abort the import.
    const when = new Date(entry.timestamp);
    if (Number.isNaN(when.getTime())) continue;
    if (captured.has(entry.sessionId)) continue;

    let s = sessions.get(entry.sessionId);
    if (!s) sessions.set(entry.sessionId, (s = { tokens: [], entries: 0, builtinEntries: 0 }));
    s.entries++;

    // First token of the first display line only — the rest of the entry is
    // prose and pasted content, and none of it is ever read.
    const token = entry.display.split("\n", 1)[0].trim().split(/\s+/, 1)[0];
    if (!TYPED_TOKEN_RE.test(token)) continue;
    const name = token.slice(1);
    const builtin = BUILTIN_COMMANDS.has(name);
    if (builtin) s.builtinEntries++;
    s.tokens.push({ name, builtin, ts: when.toISOString(), project: entry.project, line: i + 1 });
  }

  const unresolved = new Set<string>();
  const events: LedgerEvent[] = [];
  for (const [sessionId, s] of sessions) {
    // A rule about session SHAPE, not about the token, which is why it lives
    // here and not in the ledger's gate: a session that is 100% built-ins is
    // automation, not use (the observed ~10.8-minute /usage poller) — dropped
    // even when built-ins are being imported.
    if (s.builtinEntries === s.entries) {
      result.droppedPollerSessions++;
      continue;
    }
    for (const t of s.tokens) {
      // Built-in tokens are emitted and let the ledger's durable preference
      // decide, so this importer and the other two typed-channel writers can
      // never disagree about the same fire.
      const isSkill = !t.builtin && inventoryNames.skills.has(t.name);
      if (!t.builtin && !isSkill && !inventoryNames.commands.has(t.name)) unresolved.add(t.name);
      events.push({
        v: 1,
        // Same key rule as transcript-derived typed commands, but the
        // session exclusion above is what actually prevents double counting.
        id: `${sessionId}:${t.ts}:${t.name}`,
        ts: t.ts,
        provider: "claude",
        kind: isSkill ? "skill" : "command",
        name: t.name,
        channel: "typed",
        sessionId,
        project: t.project,
        src: { file, line: t.line },
        backfill: true,
      });
    }
  }

  const r = ledger.appendEvents(events);
  result.imported = r.appended;
  result.droppedBuiltins = r.droppedBuiltins;
  result.unresolved = [...unresolved].sort();
  return result;
}
