import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every SQLite touch in this codebase lives here. Cursor is the only source
 * whose history is a database rather than JSONL, and `node:sqlite` is available
 * only on Node >= 22.13 / >= 23.4 while this package's engines say >= 18 — so
 * the dependency is loaded through one dynamic, catch-wrapped door, and every
 * failure past it degrades the cursor provider to "no readable history" instead
 * of taking the scan down with it.
 */

type SqliteModule = typeof import("node:sqlite");
type Db = InstanceType<SqliteModule["DatabaseSync"]>;
type Row = Record<string, unknown>;

/**
 * Cursor's user-data directory per platform. Probed in order against the
 * INJECTED home rather than read from the environment, so a test pointed at a
 * fabricated home never reads the real machine's conversations.
 */
const USER_DIR_CANDIDATES: string[][] = [
  ["Library", "Application Support", "Cursor", "User"], // macOS
  [".config", "Cursor", "User"], // Linux
  ["AppData", "Roaming", "Cursor", "User"], // Windows
];

/** Rule references are dispatch tokens; anything longer is prose, and prose never enters the ledger. */
const MAX_NAME = 80;

/** Epoch-ms guards: Cursor's createdAt is unvalidated, and a 1970 or year-3000 row would define the window. */
const MIN_TS = Date.parse("2005-01-01T00:00:00Z");
const MAX_TS = Date.parse("2100-01-01T00:00:00Z");

/** One rule attached to one message, already dated and attributed — a fully resolved row. */
export interface CursorRuleAttachment {
  /** Cursor's conversation id — the ledger's sessionId. */
  composerId: string;
  /** The message the rule rode along with. */
  bubbleId: string;
  /** Display name, reduced to the same token `discover()` keys rule assets by. */
  name: string;
  /** ISO — the CONVERSATION's createdAt; Cursor records no per-message time. */
  ts: string;
  /** Workspace folder the conversation belongs to; "" when no workspace claims it. */
  project: string;
}

/**
 * What one read of the global store found, including everything it could NOT
 * read. The counters are not diagnostics for us — they are the caveat text the
 * user sees, so an unrecognized record shows up as a stated unknown rather than
 * vanishing into a smaller count.
 */
export interface CursorStoreFacts {
  /** The store probed, or undefined when this machine has no Cursor user dir. */
  storePath?: string;
  /** The store opened and every query returned. False ⇒ no readable history, full stop. */
  readable: boolean;
  /** Why the store could not be read — set exactly when `readable` is false and a store existed. */
  unreadable?: string;
  /** Deduped (composer, message, rule) attachments. */
  attachments: CursorRuleAttachment[];
  /** Conversations examined — the denominator behind "no rule attachments recorded". */
  composers: number;
  /** Message records examined across both tables that carry rule references. */
  bubbles: number;
  /** ISO createdAt range over ALL conversations — the observation window. */
  windowStart?: string;
  windowEnd?: string;
  /** Rule references whose element shape carried no readable name. Counted, never guessed at. */
  unparsed: number;
  /** Records whose value was not the JSON object the schema implies (Cursor stores literal `null` rows). */
  malformed: number;
  /** Attachments dropped because their conversation carried no usable createdAt — an event needs a date. */
  undated: number;
  /** Conversations that record rules only at conversation level; per-message counts exclude those. */
  conversationOnly: number;
  /** Workspaces walked for project attribution, and how many resolved to a folder. */
  workspaces: number;
  workspacesResolved: number;
}

/** Cursor's user-data dir under this home, or undefined when Cursor was never installed here. */
export function cursorUserDir(home: string): string | undefined {
  for (const parts of USER_DIR_CANDIDATES) {
    const dir = join(home, ...parts);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {}
  }
  return undefined;
}

/**
 * The global conversation store, when it exists. Exported as a synchronous
 * probe because the two callers that must decide "is there anything to read
 * here at all" — the caveat text and the dashboard's decision to run cursor
 * history at all — cannot await, and neither should pay a database open to
 * learn that the file is missing.
 */
export function cursorStorePath(home: string): string | undefined {
  const userDir = cursorUserDir(home);
  if (!userDir) return undefined;
  const store = join(userDir, "globalStorage", "state.vscdb");
  return existsSync(store) ? store : undefined;
}

/**
 * node:sqlite announces itself with an ExperimentalWarning at IMPORT time
 * (verified — not at first use), routed through `process.emitWarning` and
 * delivered on the next tick. Removing the process's default `warning`
 * listener would silence every future warning from anyone's code, which is a
 * worse bug than a noisy line; so this filters exactly one call by type AND
 * text, forwards everything else untouched, and unwinds itself the moment the
 * import settles.
 */
function muteSqliteExperimentalWarning(): () => void {
  const original = process.emitWarning;
  const patched = (warning: unknown, ...rest: unknown[]): void => {
    const first = rest[0] as { type?: string } | string | undefined;
    const type = typeof first === "string" ? first : first?.type;
    const message = warning instanceof Error ? warning.message : String(warning);
    if (type === "ExperimentalWarning" && /\bSQLite\b/.test(message)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = patched as typeof process.emitWarning;
  return () => {
    // Restore only OUR patch: something else may have wrapped emitWarning
    // inside the window, and blindly reinstating the original would delete
    // their filter along with ours.
    if (process.emitWarning === patched) process.emitWarning = original;
  };
}

let sqliteModule: Promise<SqliteModule | undefined> | undefined;

/**
 * Memoized because the import is where the experimental warning fires — once
 * per process — and because a second failed import on Node 18 would pay the
 * resolution cost again to learn the same thing.
 */
function loadSqlite(): Promise<SqliteModule | undefined> {
  sqliteModule ??= (async () => {
    const unmute = muteSqliteExperimentalWarning();
    try {
      return await import("node:sqlite");
    } catch {
      // Node < 22.13 (or 22.5–22.12 without --experimental-sqlite): the module
      // is simply absent. A static import would have crashed the whole CLI at
      // startup on a runtime this package claims to support.
      return undefined;
    } finally {
      unmute();
    }
  })();
  return sqliteModule;
}

const memo = new Map<string, CursorStoreFacts>();

/**
 * The most recent read for this home, when one has happened in this process.
 * `SourceAdapter.caveats` is synchronous by contract while the store read is
 * async, so the read memoizes its outcome and the caveat text picks it up —
 * which is what lets the caveat say "no rule attachments recorded in 39
 * conversations" instead of a generic disclaimer.
 */
export function lastCursorStoreRead(home: string): CursorStoreFacts | undefined {
  return memo.get(home);
}

/** BLOB columns come back as bytes; TEXT as a string. Both hold the same JSON. */
function toText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

/**
 * A record's JSON object, or null when there isn't one. Cursor really stores
 * rows whose value is the literal string `null` — JSON.parse SUCCEEDS on those
 * and yields null — so the guard has to be on the parsed VALUE, not on the
 * parse throwing.
 */
function parseObject(value: unknown): Record<string, unknown> | null {
  const text = toText(value);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Row streaming. The bubble table is the bulk of a store that runs to tens of
 * megabytes, and `.all()` would materialize every conversation blob at once;
 * `iterate()` (present on exactly the runtimes where node:sqlite is unflagged)
 * hands back one row at a time. The array fallback keeps a runtime without it
 * working rather than degrading a whole provider over an API detail.
 */
function scan(db: Db, sql: string, ...params: string[]): Iterable<Row> {
  const stmt = db.prepare(sql);
  const it = (stmt as { iterate?: (...a: string[]) => Iterable<Row> }).iterate;
  if (typeof it === "function") return it.call(stmt, ...params) as Iterable<Row>;
  return stmt.all(...params) as Row[];
}

/**
 * `;` is the byte after `:`, so a `key >= 'prefix:' AND key < 'prefix;'` range
 * is a prefix scan on the UNIQUE key index — a `LIKE 'prefix:%'` would read
 * every row of a 2,900-row, 55 MB table to answer the same question.
 */
function prefixScan(db: Db, prefix: string): Iterable<Row> {
  return scan(db, "SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?", `${prefix}:`, `${prefix};`);
}

/** `<prefix>:<composerId>:<bubbleId>` — both ids are UUIDs, so the first colon splits them. */
function splitPair(key: string, prefix: string): { composerId: string; bubbleId: string } | undefined {
  const rest = key.slice(prefix.length + 1);
  const i = rest.indexOf(":");
  if (i <= 0 || i >= rest.length - 1) return undefined;
  return { composerId: rest.slice(0, i), bubbleId: rest.slice(i + 1) };
}

/** Fields observed or plausible on a rule reference, most specific first. */
const NAME_FIELDS = ["name", "ruleName", "relativePath", "path"] as const;

/**
 * Reduce a rule reference to the token `discover()` keys rule assets by (file
 * basename minus .mdc/.md). A path-shaped record left whole could never join to
 * the row it describes, and would render as a second, nameless rule.
 */
function displayName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  const base = trimmed.split(/[\\/]/).pop()?.replace(/\.(mdc|md)$/i, "") ?? "";
  // Over-long strings are rule TEXT, not a reference to one. The ledger's
  // promise is that it stores names and never content, so this is dropped as
  // unrecognized rather than truncated into a plausible-looking name.
  if (!base || base.length > MAX_NAME) return undefined;
  return base;
}

/**
 * The element shape of `cursorRules` is unknown — every recorded array on the
 * reference machine is empty, so there is nothing to pattern-match against.
 * Accept the shapes Cursor's own code would plausibly write, and COUNT
 * everything else: an unrecognized element that vanished silently would shrink
 * a fire count with no trace, and one that was guessed at would invent a name.
 */
function ruleName(el: unknown): string | undefined {
  if (typeof el === "string") return displayName(el);
  if (typeof el !== "object" || el === null) return undefined;
  const rec = el as Record<string, unknown>;
  for (const f of NAME_FIELDS) {
    const v = rec[f];
    // Keep trying the remaining fields when one holds something unusable: a
    // record carrying both a paragraph in `name` and a real path in `path`
    // still has a name in it, and stopping at the first hit would lose it.
    if (typeof v === "string") {
      const n = displayName(v);
      if (n) return n;
    }
  }
  return undefined;
}

function ruleNames(raw: unknown): { names: string[]; unparsed: number } {
  if (raw === undefined || raw === null) return { names: [], unparsed: 0 };
  // A `cursorRules` that is not an array is a schema change, not a rule.
  if (!Array.isArray(raw)) return { names: [], unparsed: 1 };
  const names: string[] = [];
  let unparsed = 0;
  for (const el of raw) {
    const n = ruleName(el);
    if (n) names.push(n);
    else unparsed++;
  }
  return { names, unparsed };
}

/** Cursor's epoch-ms createdAt as ISO, or undefined when it is absent or implausible. */
function isoFrom(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  if (ms < MIN_TS || ms > MAX_TS) return undefined;
  return new Date(ms).toISOString();
}

/**
 * composerId → workspace folder. Each workspace keeps its own state.vscdb whose
 * `composer.composerData` lists the conversations opened in it; the global
 * store itself records no folder at all, so without this every cursor fire
 * would land in one nameless bucket. Every workspace is read in its own
 * try/catch: one locked or corrupt workspace db must not cost the other six
 * their attribution.
 */
function workspaceProjects(
  mod: SqliteModule,
  userDir: string
): { projects: Map<string, string>; workspaces: number; resolved: number } {
  const projects = new Map<string, string>();
  const root = join(userDir, "workspaceStorage");
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return { projects, workspaces: 0, resolved: 0 };
  }
  let workspaces = 0;
  let resolved = 0;
  for (const name of entries) {
    const dir = join(root, name);
    let folder: string | undefined;
    try {
      if (!statSync(dir).isDirectory()) continue;
      workspaces++;
      const meta = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")) as { folder?: unknown };
      // Only single-folder workspaces name a path here; a .code-workspace or a
      // remote URI resolves to nothing, and a guessed path is worse than none.
      if (typeof meta.folder === "string") folder = fileURLToPath(meta.folder);
    } catch {
      continue;
    }
    if (!folder) continue;
    const wsStore = join(dir, "state.vscdb");
    if (!existsSync(wsStore)) continue;
    let db: Db | undefined;
    try {
      db = new mod.DatabaseSync(wsStore, { readOnly: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as Row | undefined;
      const parsed = parseObject(row?.value);
      const all = parsed && Array.isArray(parsed.allComposers) ? parsed.allComposers : [];
      let claimed = 0;
      for (const c of all) {
        const id = (c as { composerId?: unknown })?.composerId;
        // First writer wins over the SORTED workspace list: a conversation
        // opened in two windows must land in the same project on every run, or
        // the same scan would report different project splits.
        if (typeof id === "string" && id && !projects.has(id)) {
          projects.set(id, folder);
          claimed++;
        }
      }
      if (claimed > 0) resolved++;
    } catch {
      continue;
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  return { projects, workspaces, resolved };
}

/**
 * Read every rule attachment Cursor recorded, read-only. Any surprise at the
 * table level (missing table, renamed column, a store locked by a running
 * Cursor in WAL mode) abandons the whole read: a partial count presented as a
 * total is the one failure mode this tool cannot afford.
 */
export async function readCursorStore(home: string): Promise<CursorStoreFacts> {
  const storePath = cursorStorePath(home);
  const facts: CursorStoreFacts = {
    storePath,
    readable: false,
    attachments: [],
    composers: 0,
    bubbles: 0,
    unparsed: 0,
    malformed: 0,
    undated: 0,
    conversationOnly: 0,
    workspaces: 0,
    workspacesResolved: 0,
  };
  memo.set(home, facts);
  if (!storePath) return facts;

  const mod = await loadSqlite();
  if (!mod) {
    facts.unreadable =
      `this Node (${process.version}) has no node:sqlite — reading Cursor's store needs Node 22.13+ or 23.4+`;
    return facts;
  }

  const userDir = cursorUserDir(home)!;
  let db: Db | undefined;
  try {
    // Read-only by construction: this tool measures, and a scan must never be
    // able to write to the store the user's editor is holding open.
    db = new mod.DatabaseSync(storePath, { readOnly: true });
  } catch (err) {
    facts.unreadable = `could not open ${storePath} read-only (${short(err)})`;
    return facts;
  }

  try {
    const createdAt = new Map<string, string>();
    const conversationLevel = new Set<string>();
    for (const row of prefixScan(db, "composerData")) {
      const key = typeof row.key === "string" ? row.key : "";
      const id = key.slice("composerData:".length);
      if (!id) continue;
      facts.composers++;
      const obj = parseObject(row.value);
      if (!obj) {
        facts.malformed++;
        continue;
      }
      const iso = isoFrom(obj.createdAt);
      if (iso) {
        createdAt.set(id, iso);
        // The window is the whole recorded range, not the range of
        // conversations that happened to attach a rule — a window defined by
        // its own hits can never contain a zero.
        if (!facts.windowStart || iso < facts.windowStart) facts.windowStart = iso;
        if (!facts.windowEnd || iso > facts.windowEnd) facts.windowEnd = iso;
      }
      const ctx = (obj.context as Record<string, unknown> | undefined)?.cursorRules;
      const conv = ruleNames(ctx);
      facts.unparsed += conv.unparsed;
      if (conv.names.length > 0) conversationLevel.add(id);
    }

    // Both tables key rule references by (conversation, message) — the same
    // pair, recorded twice — so a Set on that pair collapses the duplicate
    // instead of counting one attachment as two loads.
    const seen = new Set<string>();
    const withAttachments = new Set<string>();
    const raw: { composerId: string; bubbleId: string; name: string }[] = [];
    for (const prefix of ["bubbleId", "messageRequestContext"]) {
      for (const row of prefixScan(db, prefix)) {
        const key = typeof row.key === "string" ? row.key : "";
        const pair = splitPair(key, prefix);
        if (!pair) continue;
        const obj = parseObject(row.value);
        if (!obj) {
          facts.malformed++;
          continue;
        }
        if (!("cursorRules" in obj)) continue;
        facts.bubbles++;
        const { names, unparsed } = ruleNames(obj.cursorRules);
        facts.unparsed += unparsed;
        for (const name of names) {
          const id = `${pair.composerId} ${pair.bubbleId} ${name}`;
          if (seen.has(id)) continue;
          seen.add(id);
          withAttachments.add(pair.composerId);
          raw.push({ composerId: pair.composerId, bubbleId: pair.bubbleId, name });
        }
      }
    }

    // Attribution is only worth its seven database opens when there is
    // something to attribute — and a "resolved 5 of 7 workspaces" caveat on a
    // store with no attachments qualifies a number nobody is shown.
    const { projects, workspaces, resolved } =
      raw.length > 0 ? workspaceProjects(mod, userDir) : { projects: new Map<string, string>(), workspaces: 0, resolved: 0 };
    facts.workspaces = workspaces;
    facts.workspacesResolved = resolved;

    for (const a of raw) {
      const ts = createdAt.get(a.composerId);
      // No date, no event: every ledger figure is windowed, and an undated
      // fire would have to be given a date this store does not contain.
      if (!ts) {
        facts.undated++;
        continue;
      }
      facts.attachments.push({
        ...a,
        ts,
        // "" rather than a stand-in path: the join already renders an
        // unattributed event as "(unknown)", and a fabricated project would be
        // indistinguishable from a real one.
        project: projects.get(a.composerId) ?? "",
      });
    }
    // Sorted so the emitted event stream is identical run to run regardless of
    // how SQLite happened to return the rows.
    facts.attachments.sort(
      (x, y) => x.ts.localeCompare(y.ts) || x.composerId.localeCompare(y.composerId) ||
        x.bubbleId.localeCompare(y.bubbleId) || x.name.localeCompare(y.name)
    );
    for (const id of conversationLevel) if (!withAttachments.has(id)) facts.conversationOnly++;
    facts.readable = true;
  } catch (err) {
    // A shape surprise mid-scan invalidates everything already collected: half
    // a table is not a smaller count, it is an unknown one.
    facts.readable = false;
    facts.unreadable = `Cursor's store did not have the expected shape (${short(err)})`;
    facts.attachments = [];
    facts.composers = 0;
    facts.bubbles = 0;
    facts.unparsed = 0;
    facts.malformed = 0;
    facts.undated = 0;
    facts.conversationOnly = 0;
    facts.workspaces = 0;
    facts.workspacesResolved = 0;
    facts.windowStart = undefined;
    facts.windowEnd = undefined;
  } finally {
    try {
      db.close();
    } catch {}
  }
  return facts;
}

/** Error text short enough to sit inside a caveat line, never a stack. */
function short(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/\s+/g, " ").slice(0, 120);
}
