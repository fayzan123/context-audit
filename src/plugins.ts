import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { discoverSkills, fileAsset, mdFilesUnder } from "./skills.js";
import type { Skill, UiSuperseded } from "./types.js";

export interface PluginInstall {
  /** Plugin name without the marketplace suffix, e.g. "superpowers". */
  name: string;
  marketplace?: string;
  version: string;
  /** Root of the ACTIVE version's files — the only version that is audited. */
  root: string;
  /** settings.json enabledPlugins verdict; absent from settings means enabled. */
  enabled: boolean;
  /**
   * How many distinct installs of this plugin were on disk. More than one
   * means a choice was made about which the figures describe — reported as a
   * caveat rather than silently resolved.
   */
  candidates?: number;
  /** Manifest `installedAt` of the chosen entry, ISO — when the plugin first arrived. */
  installedAt?: string;
  /**
   * Manifest `lastUpdated` of the chosen entry, ISO. This is "the CURRENT
   * VERSION has been in place since", NOT a second install date: superpowers on
   * the reference machine reads installedAt 2026-03-24 / lastUpdated
   * 2026-07-25 — one install, one update, four months apart. Every
   * fires-across-the-update-boundary figure splits the ledger on this
   * timestamp, so reading it as an install date would move the boundary by
   * months and quietly invent a "0 fires since update" that never happened.
   */
  lastUpdated?: string;
}

export interface PluginResolution {
  installs: PluginInstall[];
  /**
   * "config" when active versions came from installed_plugins.json;
   * "newest-fallback" when that file was missing or unreadable and the cache
   * was resolved to newest-version-per-plugin instead. The UI shows the
   * fallback as a caveat — plugins are the majority of real injection, so
   * degrading beats dropping them.
   */
  resolution: "config" | "newest-fallback";
}

/** True when `ancestor` is `p` itself or a directory containing it. */
function containsPath(ancestor: string, p: string): boolean {
  return p === ancestor || p.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function statOf(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 2000-01-01T00:00:00Z — the same floor `provenance.ts` applies. Below it a
 * timestamp is a filesystem or serializer default, not a date.
 */
const MIN_VALID_MS = 946684800000;

/**
 * Marketplace and plugin names arrive from installed_plugins.json keys and
 * cache directory names — neither is under this tool's control — and both get
 * joined into filesystem paths below.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A manifest timestamp normalized to ISO. The field has carried both ISO
 * strings and epoch milliseconds across Claude Code versions, so both are
 * accepted; a 1970-shaped value is rejected outright because it is a default
 * standing in for "unknown". Passing one through would date an install before
 * the product existed and, worse, anchor the update boundary at the epoch,
 * putting every recorded fire on the "since update" side.
 */
function parseManifestDate(x: unknown): string | undefined {
  const ms = typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(ms) && ms > MIN_VALID_MS ? new Date(ms).toISOString() : undefined;
}

/** enabledPlugins from settings.json: only an explicit `false` disables. */
function enabledMap(home: string): Record<string, unknown> {
  const settings = readJson(join(home, ".claude", "settings.json"));
  return settings?.enabledPlugins && typeof settings.enabledPlugins === "object"
    ? settings.enabledPlugins
    : {};
}

/**
 * Newest-first comparison for version directory names. Not full semver — the
 * cache uses plain x.y.z directories — but numeric-aware so 10.0.0 beats 9.9.9.
 *
 * Two orderings have to be deliberate, because this decides which version of a
 * plugin the whole report describes:
 *  - A RELEASE outranks its own prerelease. `parseInt("0-beta")` is 0, so
 *    `1.0.0-beta` tied with `1.0.0` numerically and then won the lexical
 *    tiebreak, making the fallback describe a beta the user was not running.
 *  - A numeric version outranks a non-numeric directory name. Skipping NaN
 *    components dropped `latest`/`beta` through to a descending lexical
 *    compare, which ranked them above `10.0.0` — so a stray directory in the
 *    cache decided the audit.
 */
const versionParts = (v: string): number[] =>
  v.split(".").map((n) => {
    const parsed = parseInt(n, 10);
    return Number.isNaN(parsed) ? -1 : parsed;
  });
const isNumericVersion = (v: string): boolean => /^\d+(?:\.\d+)*$/.test(v);

function newestVersion(a: string, b: string): number {
  const na = isNumericVersion(a);
  const nb = isNumericVersion(b);
  if (na !== nb) return na ? -1 : 1; // a real version always beats a stray name
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    // A missing component reads as 0 so 1.0 and 1.0.0 compare equal, while a
    // non-numeric one reads as -1 so 1.0.0-beta sorts below 1.0.0.
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return b.localeCompare(a);
}

/**
 * Resolve which plugin versions are actually live. The cache keeps every
 * downloaded version side by side (superpowers 5.1.0 + 6.1.1 + 6.2.0 on a real
 * machine); auditing all of them would double- and triple-count the exact
 * numbers the header exists to get right. installed_plugins.json names the
 * active install; the cache-walk fallback exists so an unreadable config
 * degrades to a caveat instead of dropping the majority of real injection.
 */
export function resolveActivePlugins(home: string): PluginResolution {
  const cacheRoot = join(home, ".claude", "plugins", "cache");
  const enabled = enabledMap(home);
  const isEnabled = (key: string): boolean => enabled[key] !== false;
  // Resolved once: the ancestor test below has to compare real paths, or a
  // symlinked HOME defeats it.
  let claudeRoot = join(home, ".claude");
  try {
    claudeRoot = realpathSync(claudeRoot);
  } catch {
    /* not present — nothing can be an ancestor of it that matters */
  }

  const config = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  const plugins = config?.plugins;
  if (plugins && typeof plugins === "object") {
    const installs: PluginInstall[] = [];
    for (const [key, entries] of Object.entries(plugins)) {
      if (!Array.isArray(entries)) continue;
      const at = key.lastIndexOf("@");
      const name = at > 0 ? key.slice(0, at) : key;
      const marketplace = at > 0 ? key.slice(at + 1) : undefined;
      // ONE install per plugin, however many entries name it.
      //
      // Entries repeat for two reasons and both used to inflate the report.
      // Spelling: `/x`, `/x/` and `/x/.` are one directory, so keying dedup on
      // the string counted it three times. Scope: a user-scope and a
      // project-scope entry can name different roots at different versions —
      // and inventorying both double-counted every asset in the plugin, then
      // collapsed the two copies' security findings together by dispatch name,
      // which could hide a payload in the live copy behind an identical
      // finding filed against the stale one.
      //
      // Dispatch settles it: a plugin's assets fire as `plugin:name`, so two
      // copies cannot both be live under that name — one shadows the other.
      // Highest version wins (deterministic, and the shape Claude Code
      // resolves toward), and `candidates` records that a choice was made so
      // the report can say so instead of presenting it as the only reading.
      const byRealPath = new Map<string, { entry: any; root: string }>();
      for (const e of entries) {
        const root = typeof e?.installPath === "string" ? e.installPath : undefined;
        if (!root || !existsSync(root)) continue;
        let real: string;
        try {
          real = realpathSync(root);
        } catch {
          continue;
        }
        // A "plugin" rooted at ~/.claude (or above it) is not a plugin. The
        // path comes from a JSON file this tool does not control, and taking
        // it at face value re-inventoried every user skill, command and agent
        // a second time under the plugin's namespace — inflating the counts,
        // the listing figure and the injected cost the report exists to state
        // precisely.
        if (containsPath(real, claudeRoot)) continue;
        if (!byRealPath.has(real)) byRealPath.set(real, { entry: e, root });
      }
      const candidates = [...byRealPath.values()];
      if (candidates.length === 0) continue;
      const chosen = candidates.slice().sort((a, b) =>
        newestVersion(
          typeof a.entry.version === "string" ? a.entry.version : "0",
          typeof b.entry.version === "string" ? b.entry.version : "0"
        ) || a.root.localeCompare(b.root)
      )[0];
      installs.push({
        name,
        marketplace,
        version: typeof chosen.entry.version === "string" ? chosen.entry.version : "unknown",
        root: chosen.root,
        enabled: isEnabled(key),
        candidates: candidates.length,
        // From the CHOSEN entry, not the earliest one: these two describe the
        // install whose files this report measures. (Provenance separately
        // takes the earliest installedAt across entries, because "when did this
        // plugin first arrive" is a different question from "which copy is
        // live" — the two are only equal when there is one entry.)
        installedAt: parseManifestDate(chosen.entry?.installedAt),
        lastUpdated: parseManifestDate(chosen.entry?.lastUpdated),
      });
    }
    return { installs, resolution: "config" };
  }

  // Fallback: cache/<marketplace>/<plugin>/<version>/ — newest version wins.
  // No install/update dates here: only the manifest records them, and this
  // branch runs precisely because the manifest could not be read. A version
  // directory's birthtime dates the download, not the install decision, so
  // inferring one would be a fabrication — the update boundary stays absent.
  const installs: PluginInstall[] = [];
  if (existsSync(cacheRoot)) {
    for (const marketplace of listDirs(cacheRoot)) {
      for (const name of listDirs(join(cacheRoot, marketplace))) {
        const versions = listDirs(join(cacheRoot, marketplace, name)).sort(newestVersion);
        if (versions.length === 0) continue;
        installs.push({
          name,
          marketplace,
          version: versions[0],
          root: join(cacheRoot, marketplace, name, versions[0]),
          enabled: isEnabled(`${name}@${marketplace}`),
        });
      }
    }
  }
  return { installs, resolution: "newest-fallback" };
}

/**
 * Best-effort "newest version the marketplace lists" for an install. The
 * marketplace checkout is a local git clone that Claude Code refreshes on its
 * own schedule, so this is "latest as of the last marketplace sync" — never a
 * network claim. Returns undefined whenever the answer cannot be determined
 * from local files; the UI then makes no update-available claim at all, which
 * is different from claiming "up to date".
 *
 * No DATE comes back with it, deliberately. The spec's "1.4.0 available since
 * 47d" needs a publication date, and nothing on disk carries one: the official
 * marketplace checkout is a GCS sync (`.gcs-sha`, no `.git`) overwritten whole
 * on refresh, `known_marketplaces.json` `lastUpdated` and the checkout's own
 * mtimes date THAT SYNC, and `plugin-catalog-cache.json`'s `fetchedAt` dates a
 * fetch. Each would read as "available since today" for a version published
 * months ago — an age understated by the whole interval, presented as a fact.
 * Answering it needs the network, so the age is simply not offered.
 */
export function latestKnownVersion(home: string, install: PluginInstall): string | undefined {
  // The marketplace name comes from installed_plugins.json keys and the
  // source path from the marketplace manifest — both attacker-influenced
  // files, both joined into filesystem paths here. Reject anything shaped
  // like a traversal rather than resolving it.
  if (!install.marketplace || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(install.marketplace)) {
    return undefined;
  }
  const mpRoot = join(home, ".claude", "plugins", "marketplaces", install.marketplace);
  const manifest = readJson(join(mpRoot, ".claude-plugin", "marketplace.json"));
  const entry = Array.isArray(manifest?.plugins)
    ? manifest.plugins.find((p: any) => p?.name === install.name)
    : undefined;
  if (!entry) return undefined;
  if (typeof entry.version === "string") return entry.version;
  const src = entry.source;
  // In-repo plugins ("./plugins/x") carry their manifest inside the checkout.
  if (typeof src === "string" && !src.split(/[\\/]/).includes("..")) {
    const pj = readJson(join(mpRoot, src, ".claude-plugin", "plugin.json"));
    if (typeof pj?.version === "string") return pj.version;
  }
  // Git-pinned plugins encode the version in the ref tag ("v1.5.5").
  if (src && typeof src === "object" && typeof src.ref === "string") {
    const m = /^v?(\d+(?:\.\d+)+)$/.exec(src.ref);
    if (m) return m[1];
  }
  return undefined;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.name.startsWith(".")) return false;
        try {
          return statSync(join(dir, e.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Bytes under a directory, following NO symlink.
 *
 * `Dirent.isDirectory()` is lstat-shaped, so a symlinked subdirectory is never
 * descended: a cache directory linking to its own parent — or to `~` — would
 * otherwise either spin forever or bill the user for their whole home
 * directory under a "superseded plugin versions" heading. Unreadable entries
 * are skipped rather than thrown: a total short by one file is still a usable
 * measure, while an exception here would take down the scan that produced it.
 * The depth cap is belt-and-braces for a tree no plugin should ever have.
 */
function dirBytes(dir: string, depth = 0): number {
  if (depth > 32) return 0;
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += dirBytes(p, depth + 1);
    else if (e.isFile()) total += statOf(p)?.size ?? 0;
  }
  return total;
}

/**
 * Plugin versions still sitting in the cache that nothing resolves to any more
 * — the disk cost of past updates. Paths are PRINTED, never touched: this tool
 * measures, and a delete here would be the one irreversible thing it does.
 *
 * "Superseded" is decided against the ACTIVE INSTALL, three ways: the version
 * string it names, the realpath its root actually points at, and the ORDERING.
 * The second test is what keeps a live directory out of this list when the
 * manifest version and the directory name disagree (an entry whose `version` is
 * missing resolves to "unknown", which matches no directory) — printing the
 * running plugin as dead weight would be worse than printing nothing.
 *
 * The third test is what keeps a cached version NEWER than the live one out of
 * it. That directory is the pending update: `updateRelevance` names the same
 * path as "the update available" and the drawer offers its diff, so listing it
 * here told the reader to delete the version it was telling them to read. The
 * predicate is deliberately the same one `updateRelevance` filters on, so the
 * two can never disagree about a single directory.
 *
 * Caches with no matching install at all are skipped: an uninstalled plugin's
 * leftovers are orphans, not superseded versions, and there is no active
 * version to name them against.
 */
export function supersededVersions(home: string, installs: PluginInstall[]): UiSuperseded[] {
  const cacheRoot = join(home, ".claude", "plugins", "cache");
  if (!existsSync(cacheRoot)) return [];
  let realCacheRoot = cacheRoot;
  try {
    realCacheRoot = realpathSync(cacheRoot);
  } catch {
    /* unreadable — the containment test below then rejects everything */
  }

  // Keyed on marketplace/name because that is the cache's own layout. An
  // install with no marketplace (a config key with no `@`) cannot be located
  // in the cache at all, so nothing under it can be attributed to it.
  const active = new Map<string, PluginInstall>();
  const activeRoots = new Set<string>();
  for (const i of installs) {
    if (i.marketplace && SAFE_SEGMENT.test(i.marketplace) && SAFE_SEGMENT.test(i.name)) {
      active.set(`${i.marketplace}/${i.name}`, i);
    }
    try {
      activeRoots.add(realpathSync(i.root));
    } catch {
      /* a root that will not resolve cannot shadow anything */
    }
  }

  const out: UiSuperseded[] = [];
  for (const marketplace of listDirs(cacheRoot)) {
    if (!SAFE_SEGMENT.test(marketplace)) continue;
    for (const name of listDirs(join(cacheRoot, marketplace))) {
      if (!SAFE_SEGMENT.test(name)) continue;
      const install = active.get(`${marketplace}/${name}`);
      if (!install) continue;
      const pluginDir = join(cacheRoot, marketplace, name);
      // Which version the ordering test compares against. The manifest string
      // is preferred; when it names none ("unknown"), the cache directory the
      // live root resolves to is the remaining evidence of what is running.
      // With neither, nothing is ranked and the realpath test below stays the
      // only guard — dropping the whole group would hide real disk rather than
      // avoid a claim.
      let activeVersion = isNumericVersion(install.version) ? install.version : undefined;
      if (activeVersion === undefined) {
        try {
          const realActive = realpathSync(install.root);
          const base = basename(realActive);
          if (dirname(realActive) === realpathSync(pluginDir) && isNumericVersion(base)) activeVersion = base;
        } catch {
          /* an install root that will not resolve names no version */
        }
      }
      const versions: string[] = [];
      const paths: string[] = [];
      let bytes = 0;
      for (const version of listDirs(pluginDir).sort(newestVersion)) {
        if (version === install.version) continue;
        // Outranks the live install: this is the pending update, not dead
        // weight. Same predicate as updateRelevance's filter.
        if (activeVersion !== undefined && newestVersion(version, activeVersion) < 0) continue;
        const dir = join(pluginDir, version);
        let real: string;
        try {
          real = realpathSync(dir);
        } catch {
          continue;
        }
        if (activeRoots.has(real)) continue;
        // A version directory that is really a link out of the cache is not
        // this plugin's disk. Measuring it would bill the user for someone
        // else's files and print a foreign absolute path as if the cache
        // owned it.
        if (!containsPath(realCacheRoot, real)) continue;
        versions.push(version);
        paths.push(dir);
        bytes += dirBytes(dir);
      }
      if (versions.length > 0) {
        out.push({ plugin: name, marketplace, active: install.version, versions, bytes, paths });
      }
    }
  }
  return out.sort((a, b) => a.plugin.localeCompare(b.plugin) || (a.marketplace ?? "").localeCompare(b.marketplace ?? ""));
}

/**
 * Files at or under this are hashed whole; anything larger is hashed by its
 * first megabyte plus its size. The comparison below answers one drawer line —
 * "does the newer cached version change this skill's files" — and reading
 * gigabytes of cached binaries to answer it is not a trade worth making. The
 * honest consequence, stated here so it is never a surprise: a same-size edit
 * past the first megabyte of a multi-megabyte file reads as unchanged. Skill
 * directories are text; this cap effectively only ever binds on bundled assets.
 */
const HASH_WHOLE_MAX = 4 * 1024 * 1024;
const HASH_PREFIX = 1024 * 1024;

/** Files walked per side before the comparison gives up. */
const COMPARE_FILE_CAP = 2000;

function digest(path: string, size: number): string | undefined {
  try {
    if (size <= HASH_WHOLE_MAX) return createHash("sha256").update(readFileSync(path)).digest("hex");
    const buf = Buffer.alloc(HASH_PREFIX);
    const fd = openSync(path, "r");
    try {
      const read = readSync(fd, buf, 0, HASH_PREFIX, 0);
      return createHash("sha256").update(buf.subarray(0, read)).update(String(size)).digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** "same" | "changed" | undefined when a side could not be read — never guessed. */
function compareFile(a: string, b: string): "same" | "changed" | undefined {
  const sa = statOf(a);
  const sb = statOf(b);
  if (!sa || !sb) return undefined;
  // Size first: a differing size is a difference, and proves it without a read.
  if (sa.size !== sb.size) return "changed";
  const da = digest(a, sa.size);
  const db = digest(b, sb.size);
  if (!da || !db) return undefined;
  return da === db ? "same" : "changed";
}

/**
 * Relative file paths under `root`, symlinks skipped (same loop guard as
 * dirBytes). undefined whenever the listing is incomplete — a cap trip, a
 * directory that would not open — because "identical" cannot be claimed from a
 * partial walk, and claiming it would be the exact false reassurance this
 * comparison exists to replace.
 */
function relFiles(root: string, dir = root, depth = 0, acc: string[] = []): string[] | undefined {
  if (depth > 32) return undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!relFiles(root, p, depth + 1, acc)) return undefined;
    } else if (e.isFile()) {
      if (acc.length >= COMPARE_FILE_CAP) return undefined;
      acc.push(relative(root, p));
    }
  }
  return acc;
}

/**
 * Does a newer CACHED version of this plugin change THIS asset's files?
 *
 * A byte comparison across version directories, not a version-number
 * inference: "identical in 6.2.0" is a fact about files, and it is the
 * difference between an update the user should read release notes for and one
 * that cannot touch the skill they are looking at.
 *
 * Returns undefined — meaning UNKNOWN, which is not the claim "unchanged" —
 * whenever the comparison cannot be made honestly: no newer version cached, a
 * version string that will not order (a `latest` directory, an install whose
 * manifest carried no version), an asset that symlinks out of its own plugin,
 * a file neither side could read, or a tree past the walk cap.
 */
export function updateRelevance(
  home: string,
  install: PluginInstall,
  assetPath: string
): { version: string; identical: boolean; changedFiles?: number } | undefined {
  if (!install.marketplace || !SAFE_SEGMENT.test(install.marketplace) || !SAFE_SEGMENT.test(install.name)) {
    return undefined;
  }
  // Only comparable against a version this ordering can call newer. A
  // non-numeric active version has no defined successor, and guessing one
  // would produce "identical in latest" out of a directory name.
  if (!isNumericVersion(install.version)) return undefined;

  // The asset must live inside the install it claims to belong to, both as
  // written and after resolution: the relative path computed here is joined
  // into ANOTHER version directory below, so a `..` or an escaping symlink
  // would send the comparison outside the plugin entirely.
  const rel = relative(install.root, assetPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;

  const pluginDir = join(home, ".claude", "plugins", "cache", install.marketplace, install.name);
  let realPluginDir: string;
  let realRoot: string;
  let realAsset: string;
  try {
    realPluginDir = realpathSync(pluginDir);
    realRoot = realpathSync(install.root);
    realAsset = realpathSync(assetPath);
  } catch {
    return undefined;
  }
  if (!containsPath(realRoot, realAsset)) return undefined;
  // Newest cached version that outranks the live one AND is genuinely this
  // plugin's directory. The containment test is not paranoia: a version
  // directory that is really a link elsewhere on disk turns this comparison
  // into "read arbitrary files and report the diff as the plugin's update" —
  // a `9.9.9 -> ~/Documents` link would win the ordering every time.
  let newer: string | undefined;
  let realNewer: string | undefined;
  for (const v of listDirs(pluginDir)
    .filter((v) => isNumericVersion(v) && newestVersion(v, install.version) < 0)
    .sort(newestVersion)) {
    let real: string;
    try {
      real = realpathSync(join(pluginDir, v));
    } catch {
      continue;
    }
    if (!containsPath(realPluginDir, real)) continue;
    // The live root itself, reached under a higher version name (a manifest
    // whose `version` disagrees with its `installPath`). Comparing a directory
    // to itself would report "identical in 2.0.0" about the version already
    // running — a true statement about the wrong question.
    if (real === realRoot) continue;
    newer = v;
    realNewer = real;
    break;
  }
  if (!newer || !realNewer) return undefined;

  const other = join(realNewer, rel);
  const st = statOf(assetPath);
  if (!st) return undefined;

  // Single-file asset (a command or agent .md): one comparison, and a file the
  // newer version no longer ships is a change, not an unknown.
  if (st.isFile()) {
    if (!existsSync(other)) return { version: newer, identical: false, changedFiles: 1 };
    const verdict = compareFile(assetPath, other);
    if (!verdict) return undefined;
    return { version: newer, identical: verdict === "same", changedFiles: verdict === "same" ? 0 : 1 };
  }

  const here = relFiles(assetPath);
  if (!here) return undefined;
  // A skill directory absent from the newer version: every file is dropped.
  if (!existsSync(other)) return { version: newer, identical: here.length === 0, changedFiles: here.length };
  const there = relFiles(other);
  if (!there) return undefined;

  // The union, so files ADDED by the update count as changes too — an update
  // that only adds a reference file still changes what this skill loads.
  const hereSet = new Set(here);
  const thereSet = new Set(there);
  let changed = 0;
  for (const f of new Set([...here, ...there])) {
    if (!hereSet.has(f) || !thereSet.has(f)) {
      changed++;
      continue;
    }
    const verdict = compareFile(join(assetPath, f), join(other, f));
    if (!verdict) return undefined;
    if (verdict === "changed") changed++;
  }
  return { version: newer, identical: changed === 0, changedFiles: changed };
}

export interface PluginAsset {
  install: PluginInstall;
  skill: Skill;
}

/**
 * Instruction assets inside one active plugin version. Names carry the
 * `plugin:` prefix because that is the dispatch name the harness uses — it is
 * what appears in transcripts, so it is also what fire-history joins on.
 */
export function discoverPluginAssets(install: PluginInstall): PluginAsset[] {
  const assets: PluginAsset[] = [];

  // Containment root for everything inside this plugin. A plugin is
  // third-party code from a marketplace: a symlink reaching out of its own
  // install is not organization, and following one made the audit read — and
  // quote, as evidence — arbitrary files elsewhere on the machine. Escapes are
  // recorded and reported rather than silently skipped. User skills pass no
  // boundary and keep following their symlinks, which is deliberate.
  let boundary: string | undefined;
  try {
    boundary = realpathSync(install.root);
  } catch {
    boundary = undefined;
  }

  const skillsRoot = join(install.root, "skills");
  if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
    for (const s of discoverSkills(skillsRoot, boundary)) {
      assets.push({
        install,
        skill: {
          ...s,
          dirName: `${install.name}:${s.dirName}`,
          source: "claude",
          kind: "skill",
          injection: "description",
          fromPlugin: true,
        },
      });
    }
  }

  // Commands namespace by directory, the same rule the user-level command
  // walker applies: commands/git/commit.md is `plugin:git:commit`, not
  // `plugin:commit`. Naming it by basename alone collapsed two commands in
  // different subdirectories onto one row.
  const commandsRoot = join(install.root, "commands");
  for (const f of mdFilesUnder(commandsRoot)) {
    const name = relative(commandsRoot, f).replace(/\.md$/, "").split(sep).join(":");
    const asset = fileAsset(f, `${install.name}:${name}`, "claude", "command", "description");
    asset.fromPlugin = true;
    assets.push({ install, skill: asset });
  }

  for (const f of mdFilesUnder(join(install.root, "agents"))) {
    // basename, not split("/"): mdFilesUnder builds paths with join(), so on
    // Windows the split returned the whole absolute path as the "name".
    const fallback = basename(f, ".md");
    const asset = fileAsset(f, fallback, "claude", "agent", "description");
    asset.dirName = `${install.name}:${asset.fmName ?? fallback}`;
    asset.fromPlugin = true;
    assets.push({ install, skill: asset });
  }

  return assets;
}
