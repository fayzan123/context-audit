import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { discoverSkills, loadSkill } from "../skills.js";
import { historyFacts } from "../history.js";
import type { AssetKind, HistoryFacts, Injection, Skill } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";

/** Every .md file under a directory, symlink-tolerant, silent on unreadable entries. */
export function mdFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      let stat;
      try {
        stat = statSync(p); // follows symlinks, same policy as the skills walker
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile() && entry.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Load a single .md file as an asset with an explicit dispatch name and kind. */
export function fileAsset(
  path: string,
  name: string,
  source: Skill["source"],
  kind: AssetKind,
  injection: Injection
): Skill {
  return { ...loadSkill(path), dirName: name, source, kind, injection };
}

function skillRoots(ctx: SourceContext): string[] {
  // A Set because cwd can sit inside HOME (or be it) — auditing the same
  // directory twice would double every finding.
  return [...new Set([join(ctx.home, ".claude", "skills"), join(ctx.cwd, ".claude", "skills")])];
}

export const claudeAdapter: SourceAdapter = {
  id: "claude",

  detect(ctx) {
    return (
      existsSync(join(ctx.home, ".claude")) ||
      existsSync(join(ctx.cwd, ".claude")) ||
      existsSync(join(ctx.cwd, "CLAUDE.md"))
    );
  },

  discover(ctx) {
    const assets: Skill[] = [];

    for (const root of skillRoots(ctx)) {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      for (const s of discoverSkills(root)) {
        assets.push({ ...s, source: "claude", kind: "skill", injection: "description" });
      }
    }

    // Agents dispatch on their frontmatter name (loadSkill already prefers it).
    for (const root of new Set([join(ctx.home, ".claude", "agents"), join(ctx.cwd, ".claude", "agents")])) {
      for (const f of mdFilesUnder(root)) {
        const fallback = f.split("/").pop()!.replace(/\.md$/, "");
        const asset = fileAsset(f, fallback, "claude", "agent", "description");
        if (asset.fmName) asset.dirName = asset.fmName;
        assets.push(asset);
      }
    }

    // Commands namespace by directory: commands/foo/bar.md fires as /foo:bar.
    for (const root of new Set([join(ctx.home, ".claude", "commands"), join(ctx.cwd, ".claude", "commands")])) {
      for (const f of mdFilesUnder(root)) {
        const name = relative(root, f).replace(/\.md$/, "").split("/").join(":");
        assets.push(fileAsset(f, name, "claude", "command", "description"));
      }
    }

    // Instruction files are injected whole into every session — their body IS
    // the always-paid cost, and also the highest-value persistence target.
    const instructions: [string, string][] = [
      [join(ctx.home, ".claude", "CLAUDE.md"), "~/.claude/CLAUDE.md"],
      [join(ctx.cwd, "CLAUDE.md"), "CLAUDE.md"],
    ];
    for (const [path, name] of instructions) {
      if (existsSync(path) && statSync(path).isFile()) {
        assets.push(fileAsset(path, name, "claude", "instructions", "body"));
      }
    }

    return assets;
  },

  async usage(ctx, assets): Promise<HistoryFacts> {
    // Only kinds the transcripts actually record dispatch for: Skill tool_use
    // and <command-name>. Passing agents or CLAUDE.md here would report them as
    // "never fired", which is a claim the data cannot support.
    const dispatchable = assets.filter((a) => a.kind === "skill" || a.kind === "command");
    return historyFacts(ctx.transcripts ?? join(ctx.home, ".claude", "projects"), dispatchable);
  },
};
