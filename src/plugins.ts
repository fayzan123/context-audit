import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { discoverSkills, fileAsset, mdFilesUnder } from "./skills.js";
import type { Skill } from "./types.js";

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
      });
    }
    return { installs, resolution: "config" };
  }

  // Fallback: cache/<marketplace>/<plugin>/<version>/ — newest version wins.
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
