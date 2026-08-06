import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AssetKind, Provenance, SourceId } from "./types.js";

// Install-date resolution — one fallback chain per asset class, first valid
// link wins, and every result is labeled with the link that produced it. The
// caller snapshots winners into the ledger's provenance store (write-once)
// because the evidence here decays: plugin caches get pruned, files get
// re-saved, transcripts get purged. Pure over injected paths — nothing in this
// module reads the real $HOME or the environment.

/** The slice of an inventory row this module needs — UiItem satisfies it. */
export interface ProvenanceItem {
  id: string;
  source: SourceId;
  kind: AssetKind;
  /** Asset root: the skill directory, or the file itself for single-file assets. */
  path: string;
  scope: "user" | "project";
  plugin?: { name: string; marketplace?: string };
  /**
   * Earliest ledger event ts for this item, when the caller has one. The
   * terminal link then means "ledger first-seen" literally instead of "now".
   */
  firstSeen?: string;
}

/** Injected paths, SourceContext-style, plus a deterministic "now" for tests. */
export interface ProvenanceContext {
  home: string;
  cwd: string;
  /** ISO date stamped on first-seen results; defaults to wall clock. */
  now?: string;
}

/**
 * 2000-01-01T00:00:00Z. Birthtimes at or below this are filesystem defaults —
 * epoch 0 on filesystems that don't record creation — not installs. An invalid
 * birthtime fails open to the next chain link, never to a 1970 "install date".
 */
const MIN_VALID_MS = 946684800000;

/**
 * Files born in the same second at or past this count arrived together — a
 * pack install, not a coincidence (verified: 127/133 agent files on the
 * reference machine share one second). The shared second is the install date.
 */
const PACK_MIN = 5;

/** Path segments joined under the plugin cache come from attacker-influenced JSON. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const validMs = (ms: number): boolean => Number.isFinite(ms) && ms > MIN_VALID_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

function statOf(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** installedAt normalized to ISO — the manifest has carried both ISO strings and epoch ms. */
function parseInstalledAt(x: unknown): string | undefined {
  const ms = typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : NaN;
  return validMs(ms) ? iso(ms) : undefined;
}

/**
 * Earliest v2 `installedAt` across every config entry naming the plugin — the
 * field survives updates (`lastUpdated` is only "current version since"), and
 * the earliest entry is the original install.
 */
function manifestInstalledAt(home: string, plugin: { name: string; marketplace?: string }): string | undefined {
  const config = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  const plugins = config?.plugins;
  if (!plugins || typeof plugins !== "object") return undefined;
  let earliest: string | undefined;
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue;
    const at = key.lastIndexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : undefined;
    if (name !== plugin.name || marketplace !== plugin.marketplace) continue;
    for (const e of entries) {
      const when = parseInstalledAt(e?.installedAt);
      if (when && (!earliest || when < earliest)) earliest = when;
    }
  }
  return earliest;
}

/**
 * Oldest cache version-dir birthtime for a plugin — an under-estimate by
 * construction (pruned caches lose their oldest dirs), which the UI labels.
 */
function oldestCacheBirthtime(home: string, plugin: { name: string; marketplace?: string }): number | undefined {
  if (!SAFE_SEGMENT.test(plugin.name)) return undefined;
  if (plugin.marketplace !== undefined && !SAFE_SEGMENT.test(plugin.marketplace)) return undefined;
  const cacheRoot = join(home, ".claude", "plugins", "cache");
  const marketplaces = plugin.marketplace ? [plugin.marketplace] : listDirs(cacheRoot);
  let oldest: number | undefined;
  for (const mp of marketplaces.filter((m) => SAFE_SEGMENT.test(m))) {
    for (const version of listDirs(join(cacheRoot, mp, plugin.name))) {
      const st = statOf(join(cacheRoot, mp, plugin.name, version));
      if (st && validMs(st.birthtimeMs) && (oldest === undefined || st.birthtimeMs < oldest)) {
        oldest = st.birthtimeMs;
      }
    }
  }
  return oldest;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && statOf(join(dir, e.name))?.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
  } catch {
    return undefined;
  }
}

/**
 * First git add of the skill's entry file — when the skill entered the repo's
 * history, which for a repo skill is its install date. Guarded against shallow
 * clones, whose truncated history would date the skill at the clone's horizon.
 */
function gitFirstAdd(path: string): string | undefined {
  const st = statOf(path);
  if (!st) return undefined;
  let cwd: string;
  let entry: string;
  if (st.isFile()) {
    cwd = dirname(path);
    entry = basename(path);
  } else {
    cwd = path;
    // The harness resolves SKILL.md case-insensitively; git pathspecs do not.
    let found: string | undefined;
    try {
      found = readdirSync(path).find((n) => n.toLowerCase() === "skill.md");
    } catch {
      return undefined;
    }
    if (!found) return undefined;
    entry = found;
  }
  if (git(cwd, ["rev-parse", "--is-shallow-repository"])?.trim() !== "false") return undefined;
  const log = git(cwd, ["log", "--follow", "--diff-filter=A", "--format=%aI", "--", entry]);
  if (!log) return undefined;
  const adds = log.split("\n").map((l) => l.trim()).filter(Boolean);
  // git log lists newest first; the oldest add is the arrival.
  const ms = Date.parse(adds[adds.length - 1] ?? "");
  return validMs(ms) ? iso(ms) : undefined;
}

/**
 * Resolve an install date for every item. Deterministic given the filesystem:
 * the only non-injected input is the wall clock behind first-seen, and
 * `ctx.now` overrides that too.
 */
export function resolveProvenance(items: ProvenanceItem[], ctx: ProvenanceContext): Map<string, Provenance> {
  const now = ctx.now ?? new Date().toISOString();
  const firstSeen = (it: ProvenanceItem): Provenance => ({
    installedAt: it.firstSeen ?? now,
    source: "first-seen",
  });

  // One stat pass feeds two guards. Migration: a whole inventory born in one
  // second means the files were copied onto this machine together — those
  // birthtimes date the copy, not any install, so every birthtime link is
  // disqualified (git and the plugin manifest are unaffected; mtimes survive
  // copies that preserve them, so an mtime OUTSIDE the shared second is still
  // a real last edit — one inside it is the copy again and falls through).
  const births = new Map<ProvenanceItem, number>();
  for (const it of items) {
    const st = statOf(it.path);
    if (st && validMs(st.birthtimeMs)) births.set(it, st.birthtimeMs);
  }
  const seconds = new Set([...births.values()].map((ms) => Math.floor(ms / 1000)));
  const migrated = births.size >= PACK_MIN && seconds.size === 1;
  const migratedSec = migrated ? [...seconds][0] : undefined;
  const suspectMtime = (ms: number): boolean => migrated && Math.floor(ms / 1000) === migratedSec;

  // Pack clusters over non-plugin command/agent files only — the class that
  // ships as bundles. Meaningless under migration, where everything clusters.
  const clusters = new Map<number, number>();
  if (!migrated) {
    for (const it of items) {
      if (it.plugin || (it.kind !== "command" && it.kind !== "agent")) continue;
      const ms = births.get(it);
      if (ms === undefined) continue;
      const sec = Math.floor(ms / 1000);
      clusters.set(sec, (clusters.get(sec) ?? 0) + 1);
    }
  }

  const resolveOne = (it: ProvenanceItem): Provenance => {
    const birth = migrated ? undefined : births.get(it);

    // Plugin assets: manifest installedAt → oldest cache dir → first-seen.
    if (it.plugin) {
      const origin = it.plugin.marketplace ? `${it.plugin.name}@${it.plugin.marketplace}` : it.plugin.name;
      const at = manifestInstalledAt(ctx.home, it.plugin);
      if (at) return { installedAt: at, source: "plugin-manifest", origin };
      if (!migrated) {
        const ms = oldestCacheBirthtime(ctx.home, it.plugin);
        if (ms !== undefined) return { installedAt: iso(ms), source: "birthtime", origin };
      }
      return { ...firstSeen(it), origin };
    }

    if (it.kind === "skill") {
      // Repo skill: first git add → dir birthtime (= arrived on machine) → first-seen.
      if (it.scope === "project") {
        const added = gitFirstAdd(it.path);
        if (added) return { installedAt: added, source: "git" };
        if (birth !== undefined) return { installedAt: iso(birth), source: "birthtime" };
        return firstSeen(it);
      }
      // User-level (and codex) skill: dir birthtime → SKILL.md birthtime →
      // dir mtime (a last edit, labeled) → first-seen. Absent-dir tolerant.
      if (birth !== undefined) return { installedAt: iso(birth), source: "birthtime" };
      if (!migrated) {
        let entry: string | undefined;
        try {
          entry = readdirSync(it.path).find((n) => n.toLowerCase() === "skill.md");
        } catch {}
        const st = entry ? statOf(join(it.path, entry)) : undefined;
        if (st && validMs(st.birthtimeMs)) return { installedAt: iso(st.birthtimeMs), source: "birthtime" };
      }
      const st = statOf(it.path);
      if (st && validMs(st.mtimeMs) && !suspectMtime(st.mtimeMs)) {
        return { installedAt: iso(st.mtimeMs), source: "mtime" };
      }
      return firstSeen(it);
    }

    // Single-file assets: birthtime (pack-clustered for commands/agents) →
    // mtime → first-seen.
    if (birth !== undefined) {
      const sec = Math.floor(birth / 1000);
      const pack = it.kind === "command" || it.kind === "agent" ? (clusters.get(sec) ?? 0) : 0;
      if (pack >= PACK_MIN) {
        // The shared second dates the pack's install, not this file's authoring.
        return { installedAt: iso(sec * 1000), source: "birthtime", origin: `pack (${pack} files)` };
      }
      return { installedAt: iso(birth), source: "birthtime" };
    }
    const st = statOf(it.path);
    if (st && validMs(st.mtimeMs) && !suspectMtime(st.mtimeMs)) {
      return { installedAt: iso(st.mtimeMs), source: "mtime" };
    }
    return firstSeen(it);
  };

  const out = new Map<string, Provenance>();
  for (const it of items) out.set(it.id, resolveOne(it));
  return out;
}
