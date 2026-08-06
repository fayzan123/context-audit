import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "./ledger.js";
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

// First token of the first display line must look like a dispatch. Rejects
// pasted absolute paths (second "/") and anchor fragments ("#") — both
// observed in real history data.
const TOKEN_RE = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

// Claude Code's own commands. They say nothing about installed assets, so
// they are dropped unless the caller opts in — 3,043 of 3,179 slash entries
// on the reference machine were built-ins.
const BUILTINS = new Set([
  "usage", "status", "model", "exit", "clear", "compact", "effort", "login",
  "config", "context", "resume", "continue", "mcp", "doctor", "permissions",
  "plugins", "plugin", "voice", "rate-limit-options",
]);

export interface BackfillInventory {
  /** Skill dispatch names, no leading slash — matches import as kind "skill". */
  skills: ReadonlySet<string>;
  /** Command dispatch names — matches import as kind "command". */
  commands: ReadonlySet<string>;
}

export interface BackfillOptions {
  /** Also import built-in commands (as kind "command"). Off by default. */
  includeBuiltins?: boolean;
}

export interface BackfillResult {
  /** Events actually appended — a re-run reports 0, not the batch size. */
  imported: number;
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
    if (captured.has(entry.sessionId)) continue;

    let s = sessions.get(entry.sessionId);
    if (!s) sessions.set(entry.sessionId, (s = { tokens: [], entries: 0, builtinEntries: 0 }));
    s.entries++;

    const token = entry.display.split("\n", 1)[0].trim().split(/\s+/, 1)[0];
    if (!TOKEN_RE.test(token)) continue;
    const name = token.slice(1);
    const builtin = BUILTINS.has(name);
    if (builtin) s.builtinEntries++;
    s.tokens.push({ name, builtin, ts: new Date(entry.timestamp).toISOString(), project: entry.project, line: i + 1 });
  }

  const unresolved = new Set<string>();
  const events: LedgerEvent[] = [];
  for (const [sessionId, s] of sessions) {
    // A session that is 100% built-ins is automation, not use (the observed
    // ~10.8-minute /usage poller) — dropped even when built-ins are imported.
    if (s.builtinEntries === s.entries) {
      result.droppedPollerSessions++;
      continue;
    }
    for (const t of s.tokens) {
      if (t.builtin && !opts?.includeBuiltins) {
        result.droppedBuiltins++;
        continue;
      }
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

  result.imported = ledger.appendEvents(events).appended;
  result.unresolved = [...unresolved].sort();
  return result;
}
