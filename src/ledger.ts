import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILTIN_COMMANDS } from "./types.js";
import type { AssetKind, LedgerEvent, Provenance, SourceId } from "./types.js";

export const LEDGER_SCHEMA_VERSION = 1;

const EVENTS_FILE_RE = /^events-\d{4}-\d{2}\.jsonl$/;
const MONTH_RE = /^\d{4}-\d{2}/;
const CHANNELS = new Set(["auto", "typed", "load"]);

/**
 * Dispatch tokens only — anything shaped like args or prose is refused.
 * Shared by every writer of the typed/auto channels (hooks, transcript
 * ingestion, backfill) so the privacy gate is one regex, not one per writer.
 */
export const NAME_RE = /^[A-Za-z0-9:_-]+$/;
/**
 * A typed dispatch as the user actually types it — the leading slash is
 * REQUIRED. Writers that see raw prompt text (history.jsonl entries, Codex's
 * UserPromptSubmit payload) see every ordinary sentence too, and "please fix
 * the tests" would otherwise bank a fire named `please`: a junk row in the
 * external-fires bucket and one English word stored for no reason. Also
 * rejects pasted absolute paths (a second "/") and anchor fragments, both
 * observed in real history data. ":" is admitted so plugin dispatches like
 * /superpowers:brainstorming still match. Strictly narrower than NAME_RE, so
 * the durable boundary can never be the looser gate.
 */
export const TYPED_TOKEN_RE = /^\/[A-Za-z][A-Za-z0-9:_-]*$/;
/**
 * The durable boundary admits one extra character: codex prompt and skill
 * names legitimately carry "." (release.notes, my.skill). Load-channel events
 * record the path the harness announced as their name — a path, not a
 * dispatch token — so they are exempt where this gate is applied.
 */
const STORE_NAME_RE = /^[A-Za-z0-9:._-]+$/;

/** Optional fields a later same-id sighting may fill in on the survivor. */
const ENRICH_FIELDS = ["outcome", "interrupted", "src", "model", "entrypoint", "caller", "agent"] as const;

/**
 * Fold fields the survivor lacks from a later same-id sighting — a hook banks
 * a poor real-time record (no outcome, no src) and the scan re-derives the
 * same id carrying the transcript's enrichment. The survivor's own values are
 * never overwritten; only its gaps fill.
 */
function enrichEvent(target: LedgerEvent, from: LedgerEvent): boolean {
  let changed = false;
  for (const f of ENRICH_FIELDS) {
    if (target[f] === undefined && from[f] !== undefined) {
      (target as unknown as Record<string, unknown>)[f] = from[f];
      changed = true;
    }
  }
  return changed;
}

export interface LedgerMeta {
  schemaVersion: number;
  /** ISO-8601 — the qualifier every lifetime figure carries. */
  trackedSince: string;
  /**
   * Bank Claude Code's own slash commands as typed events (default false).
   * Durable rather than per-command because the writers do not share a command
   * line: a hook fires inside someone else's session and can only learn the
   * user's answer by reading it back off disk. Stored here, one answer governs
   * all three typed-channel writers.
   */
  includeBuiltins?: boolean;
}

/** One line per audit run — powers since-last-scan deltas. */
export interface LedgerSnapshot {
  ts: string;
  items: number;
  enabled: number;
  injectedChars: number;
  byProvider: Record<string, number>;
  /**
   * Claude's skill-listing figure at snapshot time — the series the
   * under→over budget crossing is detected on. Absent on snapshots written
   * before the field existed ("unknown", never "under").
   */
  listingChars?: number;
}

/** All conditions ANDed; ts bounds are inclusive string compares on ISO-8601. */
export interface LedgerFilter {
  provider?: SourceId;
  kind?: AssetKind;
  name?: string;
  sessionId?: string;
  since?: string;
  until?: string;
}

/** Malformed stored lines are skipped and counted here — never a crash. */
export interface LedgerDiagnostics {
  malformedLines: number;
  byFile: Record<string, number>;
}

export interface Ledger {
  /** The usage/ directory this ledger reads and writes. */
  dir: string;
  /**
   * Dedupe is by exact id; a duplicate whose copy carries optional fields the
   * stored event lacks ENRICHES it (counted in `enriched`, and persisted) —
   * counts stay deduped either way. `droppedBuiltins` counts events the
   * built-ins preference refused; they are not `skipped` (which means "already
   * banked, or malformed"), because a caller reporting them as skipped would
   * tell the user their fires were already recorded.
   */
  appendEvents(events: LedgerEvent[]): {
    appended: number;
    skipped: number;
    enriched: number;
    droppedBuiltins: number;
  };
  readEvents(filter?: LedgerFilter): LedgerEvent[];
  meta(): LedgerMeta;
  /**
   * Record the durable built-ins preference. Persisted the way provenance is —
   * whole file, atomic rename — so a half-written meta can never make the
   * ledger unreadable.
   */
  setIncludeBuiltins(on: boolean): void;
  readProvenance(): Record<string, Provenance>;
  writeProvenance(map: Record<string, Provenance>): void;
  appendSnapshot(snap: LedgerSnapshot): void;
  readSnapshots(): LedgerSnapshot[];
  diagnostics(): LedgerDiagnostics;
}

/** Explicit base > CONTEXT_AUDIT_HOME > ~/.context-audit — always injectable for tests. */
export function ledgerBase(base?: string): string {
  return base ?? process.env.CONTEXT_AUDIT_HOME ?? join(homedir(), ".context-audit");
}

/**
 * Shape gate at the durable boundary, shared with `log-event` stdin
 * validation: required fields present and typed, `ts` must actually parse as
 * a date (a month-prefixed junk string would otherwise pick a junk monthly
 * file and crash date math downstream), and dispatch-channel names must be
 * tokens — content-bearing fields (skill args, prompt text) have no place in
 * the schema at all, whichever writer sends them.
 */
export function isLedgerEvent(x: unknown): x is LedgerEvent {
  const e = x as LedgerEvent | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.v === "number" &&
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.ts === "string" &&
    MONTH_RE.test(e.ts) &&
    !Number.isNaN(Date.parse(e.ts)) &&
    typeof e.provider === "string" &&
    e.provider.length > 0 &&
    typeof e.kind === "string" &&
    e.kind.length > 0 &&
    typeof e.name === "string" &&
    e.name.length > 0 &&
    typeof e.channel === "string" &&
    CHANNELS.has(e.channel) &&
    (e.channel === "load" || STORE_NAME_RE.test(e.name)) &&
    typeof e.sessionId === "string" &&
    typeof e.project === "string"
  );
}

function writeAtomic(path: string, data: string): void {
  // rename is atomic on the same filesystem — a crash mid-write can never
  // leave a torn meta or provenance file behind.
  const tmp = path + ".tmp";
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * `mode: "append"` skips the historical event parse entirely — the per-hook-
 * fire path must not pay O(lifetime store) work to bank one line. Dedupe then
 * checks ids against only the monthly files a batch actually touches, loaded
 * lazily; reads on an append-mode ledger cover only those months.
 */
export function openLedger(base?: string, opts?: { mode?: "full" | "append" }): Ledger {
  const appendOnly = opts?.mode === "append";
  const dir = join(ledgerBase(base), "usage");
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // The store is a behavioral profile (who works on what, when) that outlives
  // the transcript purge — owner-only, and stores created before the modes
  // were set get retrofitted here. A chmod failure never blocks an audit.
  const entries = readdirSync(dir);
  try {
    chmodSync(dir, 0o700);
    for (const f of entries) {
      if (EVENTS_FILE_RE.test(f) || f === "meta.json" || f === "provenance.json" || f === "snapshots.jsonl") {
        chmodSync(join(dir, f), 0o600);
      }
    }
  } catch {}

  const diag: LedgerDiagnostics = { malformedLines: 0, byFile: {} };
  const bad = (file: string): void => {
    diag.malformedLines++;
    diag.byFile[file] = (diag.byFile[file] ?? 0) + 1;
  };

  const readLines = (file: string): unknown[] => {
    const out: unknown[] = [];
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      return out;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        bad(file);
      }
    }
    return out;
  };

  // One parse pass at open builds the dedupe index and serves every read;
  // appends keep file and memory in step. On a repeated id the first-seen
  // event survives and later lines only fill its missing optional fields —
  // that is how a durably appended enrichment line is folded back in.
  const byId = new Map<string, LedgerEvent>();
  const events: LedgerEvent[] = [];
  const loadedFiles = new Set<string>();
  const loadFile = (file: string): void => {
    if (loadedFiles.has(file)) return;
    loadedFiles.add(file);
    for (const obj of readLines(file)) {
      if (!isLedgerEvent(obj)) {
        bad(file);
        continue;
      }
      const seen = byId.get(obj.id);
      if (seen) {
        enrichEvent(seen, obj);
        continue;
      }
      byId.set(obj.id, obj);
      events.push(obj);
    }
  };
  if (!appendOnly) {
    for (const file of entries.filter((f) => EVENTS_FILE_RE.test(f)).sort()) loadFile(file);
  }

  const metaPath = join(dir, "meta.json");
  const loadMeta = (): LedgerMeta | undefined => {
    if (!existsSync(metaPath)) return undefined;
    try {
      const m = JSON.parse(readFileSync(metaPath, "utf8")) as LedgerMeta;
      if (typeof m?.schemaVersion === "number" && typeof m?.trackedSince === "string") {
        // A non-boolean preference is dropped rather than coerced: a truthy
        // string in a hand-edited meta must not silently turn built-in
        // capture on for every writer on the machine.
        if (typeof m.includeBuiltins !== "boolean") delete m.includeBuiltins;
        return m;
      }
    } catch {}
    bad("meta.json");
    return undefined;
  };
  let stored = loadMeta();
  if (!stored) {
    if (appendOnly) {
      // Without the full parse the oldest stored event is unknown — hold an
      // in-memory meta and leave the file for a full open to establish, so a
      // hook fire can never reset the horizon to its own wall clock.
      stored = { schemaVersion: LEDGER_SCHEMA_VERSION, trackedSince: new Date().toISOString() };
    } else {
      // A corrupt meta must not reset the horizon: the oldest stored event
      // proves tracking had begun by then.
      let oldest: string | undefined;
      for (const e of events) if (!oldest || e.ts < oldest) oldest = e.ts;
      stored = { schemaVersion: LEDGER_SCHEMA_VERSION, trackedSince: oldest ?? new Date().toISOString() };
      writeAtomic(metaPath, JSON.stringify(stored) + "\n");
    }
  }
  const meta = stored;

  const provPath = join(dir, "provenance.json");
  const provenance: Record<string, Provenance> = {};
  if (existsSync(provPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(provPath, "utf8"));
    } catch {}
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(provenance, parsed as Record<string, Provenance>);
    } else {
      bad("provenance.json");
    }
  }

  const snapshots: LedgerSnapshot[] = [];
  for (const obj of readLines("snapshots.jsonl")) {
    const s = obj as LedgerSnapshot;
    if (typeof s?.ts === "string") snapshots.push(s);
    else bad("snapshots.jsonl");
  }

  /**
   * The one gate all three typed-channel writers pass through. Scan ingestion,
   * hooks and backfill each used to decide this for themselves, so the same
   * `/usage` fire was banked or dropped depending on which channel happened to
   * see it — the durable store is where they agree.
   *
   * Restricted to the TYPED channel: an auto- or load-channel event named
   * "compact" is a skill, an agent or a loaded file, not Claude Code dispatching
   * its own slash command. Restricted to provider "claude" for the same reason
   * one level up — these are Claude Code's built-ins, and a Codex prompt named
   * `status` is a real asset in the user's inventory that joins to a real row.
   */
  const isBuiltinDispatch = (e: LedgerEvent): boolean =>
    e.channel === "typed" && e.provider === "claude" && BUILTIN_COMMANDS.has(e.name);

  return {
    dir,
    appendEvents(batch) {
      let appended = 0;
      let skipped = 0;
      let enriched = 0;
      let droppedBuiltins = 0;
      const byFile = new Map<string, string>();
      for (const e of batch) {
        // Invalid events land in `skipped` too — a broken hook payload must
        // never crash the caller's session.
        if (!isLedgerEvent(e)) {
          skipped++;
          continue;
        }
        // Monthly file chosen by the event's own ts, never wall clock.
        const file = `events-${e.ts.slice(0, 7)}.jsonl`;
        // Append mode checks ids against the target month only — the one file
        // this batch could collide in; a cross-month double-capture is folded
        // together by the load-time merge on the next full open.
        loadFile(file);
        const seen = byId.get(e.id);
        if (seen) {
          skipped++;
          if (enrichEvent(seen, e)) {
            // A duplicate that filled gaps is persisted append-only: the full
            // merged record lands in the SURVIVOR's monthly file, where the
            // load-time merge reconstructs this state after a reopen.
            const survivorFile = `events-${seen.ts.slice(0, 7)}.jsonl`;
            byFile.set(survivorFile, (byFile.get(survivorFile) ?? "") + JSON.stringify(seen) + "\n");
            enriched++;
          }
          continue;
        }
        // Checked only after dedupe: an id already in the store keeps taking
        // its enrichment even once the preference flips off, so turning
        // built-ins off never strips fields off events banked while it was on.
        if (!meta.includeBuiltins && isBuiltinDispatch(e)) {
          droppedBuiltins++;
          continue;
        }
        byId.set(e.id, e);
        events.push(e);
        byFile.set(file, (byFile.get(file) ?? "") + JSON.stringify(e) + "\n");
        appended++;
      }
      // One append of complete lines per touched month — concurrent writers
      // interleave whole events, never fragments.
      for (const [file, data] of byFile) appendFileSync(join(dir, file), data, { mode: 0o600 });
      return { appended, skipped, enriched, droppedBuiltins };
    },
    readEvents(filter) {
      const hit = events.filter(
        (e) =>
          (!filter?.provider || e.provider === filter.provider) &&
          (!filter?.kind || e.kind === filter.kind) &&
          (!filter?.name || e.name === filter.name) &&
          (!filter?.sessionId || e.sessionId === filter.sessionId) &&
          (!filter?.since || e.ts >= filter.since) &&
          (!filter?.until || e.ts <= filter.until)
      );
      // ts-then-id order: deterministic regardless of append interleaving.
      return hit.sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.ts < b.ts ? -1 : 1));
    },
    meta() {
      return { ...meta };
    },
    setIncludeBuiltins(on) {
      if (meta.includeBuiltins === on) return;
      meta.includeBuiltins = on;
      // An append-mode ledger that found no meta.json is holding a fabricated
      // trackedSince (its own wall clock). Persisting here would write that
      // horizon out and reset lifetime figures to the moment a hook fired, so
      // the preference applies to this process only and the file is left for a
      // full open to establish — the same rule the open path follows.
      if (appendOnly && !existsSync(metaPath)) return;
      writeAtomic(metaPath, JSON.stringify(meta) + "\n");
    },
    readProvenance() {
      // Copy, so the write-once rule can't be bypassed by mutating the map.
      return { ...provenance };
    },
    writeProvenance(map) {
      // Write-once per id: the first sighting was snapshotted before the
      // filesystem evidence decayed, so a later (worse) source never wins.
      let added = false;
      for (const [id, rec] of Object.entries(map)) {
        if (id in provenance) continue;
        provenance[id] = rec;
        added = true;
      }
      if (added) writeAtomic(provPath, JSON.stringify(provenance, null, 2) + "\n");
    },
    appendSnapshot(snap) {
      snapshots.push(snap);
      appendFileSync(join(dir, "snapshots.jsonl"), JSON.stringify(snap) + "\n", { mode: 0o600 });
    },
    readSnapshots() {
      return [...snapshots];
    },
    diagnostics() {
      return { malformedLines: diag.malformedLines, byFile: { ...diag.byFile } };
    },
  };
}
