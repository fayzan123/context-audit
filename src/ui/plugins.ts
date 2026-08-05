import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { discoverSkills } from "../skills.js";
import { fileAsset, mdFilesUnder } from "../sources/claude.js";
import type { Skill } from "../types.js";

export interface PluginInstall {
  /** Plugin name without the marketplace suffix, e.g. "superpowers". */
  name: string;
  marketplace?: string;
  version: string;
  /** Root of the ACTIVE version's files — the only version that is audited. */
  root: string;
  /** settings.json enabledPlugins verdict; absent from settings means enabled. */
  enabled: boolean;
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
 */
function newestVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (!Number.isNaN(d) && d !== 0) return d;
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

  const config = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  const plugins = config?.plugins;
  if (plugins && typeof plugins === "object") {
    const installs: PluginInstall[] = [];
    for (const [key, entries] of Object.entries(plugins)) {
      if (!Array.isArray(entries)) continue;
      const at = key.lastIndexOf("@");
      const name = at > 0 ? key.slice(0, at) : key;
      const marketplace = at > 0 ? key.slice(at + 1) : undefined;
      // Several entries can exist (user + project scope); audit each distinct
      // install path that is really on disk, once.
      const seen = new Set<string>();
      for (const e of entries) {
        const root = typeof e?.installPath === "string" ? e.installPath : undefined;
        if (!root || seen.has(root) || !existsSync(root)) continue;
        seen.add(root);
        installs.push({
          name,
          marketplace,
          version: typeof e.version === "string" ? e.version : "unknown",
          root,
          enabled: isEnabled(key),
        });
      }
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

  const skillsRoot = join(install.root, "skills");
  if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
    for (const s of discoverSkills(skillsRoot)) {
      assets.push({
        install,
        skill: {
          ...s,
          dirName: `${install.name}:${s.dirName}`,
          source: "claude",
          kind: "skill",
          injection: "description",
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
    assets.push({
      install,
      skill: fileAsset(f, `${install.name}:${name}`, "claude", "command", "description"),
    });
  }

  for (const f of mdFilesUnder(join(install.root, "agents"))) {
    // basename, not split("/"): mdFilesUnder builds paths with join(), so on
    // Windows the split returned the whole absolute path as the "name".
    const fallback = basename(f, ".md");
    const asset = fileAsset(f, fallback, "claude", "agent", "description");
    asset.dirName = `${install.name}:${asset.fmName ?? fallback}`;
    assets.push({ install, skill: asset });
  }

  return assets;
}
