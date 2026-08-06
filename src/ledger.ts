import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssetKind, LedgerEvent, Provenance, SourceId } from "./types.js";

export const LEDGER_SCHEMA_VERSION = 1;

const EVENTS_FILE_RE = /^events-\d{4}-\d{2}\.jsonl$/;
const MONTH_RE = /^\d{4}-\d{2}/;
const CHANNELS = new Set(["auto", "typed", "load"]);

export interface LedgerMeta {
  schemaVersion: number;
  /** ISO-8601 — the qualifier every lifetime figure carries. */
  trackedSince: string;
}

/** One line per audit run — powers since-last-scan deltas. */
export interface LedgerSnapshot {
  ts: string;
  items: number;
  enabled: number;
  injectedChars: number;
  byProvider: Record<string, number>;
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
  appendEvents(events: LedgerEvent[]): { appended: number; skipped: number };
  readEvents(filter?: LedgerFilter): LedgerEvent[];
  meta(): LedgerMeta;
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
 * Minimal shape gate, shared with `log-event` stdin validation: required
 * fields present and typed, nothing else inspected. Content-bearing fields
 * (skill args, prompt text) have no place in the schema at all.
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
    typeof e.provider === "string" &&
    e.provider.length > 0 &&
    typeof e.kind === "string" &&
    e.kind.length > 0 &&
    typeof e.name === "string" &&
    e.name.length > 0 &&
    typeof e.channel === "string" &&
    CHANNELS.has(e.channel) &&
    typeof e.sessionId === "string" &&
    typeof e.project === "string"
  );
}

function writeAtomic(path: string, data: string): void {
  // rename is atomic on the same filesystem — a crash mid-write can never
  // leave a torn meta or provenance file behind.
  const tmp = path + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function openLedger(base?: string): Ledger {
  const dir = join(ledgerBase(base), "usage");
  mkdirSync(dir, { recursive: true });

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
  // appends keep file and memory in step.
  const ids = new Set<string>();
  const events: LedgerEvent[] = [];
  for (const file of readdirSync(dir).filter((f) => EVENTS_FILE_RE.test(f)).sort()) {
    for (const obj of readLines(file)) {
      if (!isLedgerEvent(obj)) {
        bad(file);
        continue;
      }
      if (ids.has(obj.id)) continue;
      ids.add(obj.id);
      events.push(obj);
    }
  }

  const metaPath = join(dir, "meta.json");
  const loadMeta = (): LedgerMeta | undefined => {
    if (!existsSync(metaPath)) return undefined;
    try {
      const m = JSON.parse(readFileSync(metaPath, "utf8")) as LedgerMeta;
      if (typeof m?.schemaVersion === "number" && typeof m?.trackedSince === "string") return m;
    } catch {}
    bad("meta.json");
    return undefined;
  };
  let stored = loadMeta();
  if (!stored) {
    // A corrupt meta must not reset the horizon: the oldest stored event
    // proves tracking had begun by then.
    let oldest: string | undefined;
    for (const e of events) if (!oldest || e.ts < oldest) oldest = e.ts;
    stored = { schemaVersion: LEDGER_SCHEMA_VERSION, trackedSince: oldest ?? new Date().toISOString() };
    writeAtomic(metaPath, JSON.stringify(stored) + "\n");
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

  return {
    dir,
    appendEvents(batch) {
      let appended = 0;
      let skipped = 0;
      const byFile = new Map<string, string>();
      for (const e of batch) {
        // Invalid events land in `skipped` too — a broken hook payload must
        // never crash the caller's session.
        if (!isLedgerEvent(e) || ids.has(e.id)) {
          skipped++;
          continue;
        }
        ids.add(e.id);
        events.push(e);
        // Monthly file chosen by the event's own ts, never wall clock.
        const file = `events-${e.ts.slice(0, 7)}.jsonl`;
        byFile.set(file, (byFile.get(file) ?? "") + JSON.stringify(e) + "\n");
        appended++;
      }
      // One append of complete lines per touched month — concurrent writers
      // interleave whole events, never fragments.
      for (const [file, data] of byFile) appendFileSync(join(dir, file), data);
      return { appended, skipped };
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
      appendFileSync(join(dir, "snapshots.jsonl"), JSON.stringify(snap) + "\n");
    },
    readSnapshots() {
      return [...snapshots];
    },
    diagnostics() {
      return { malformedLines: diag.malformedLines, byFile: { ...diag.byFile } };
    },
  };
}
