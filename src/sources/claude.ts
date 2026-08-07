import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { discoverSkills, fileAsset, loadSkill, mdFilesUnder } from "../skills.js";
import { discoverPluginAssets, resolveActivePlugins } from "../plugins.js";
import { historyFacts } from "../history.js";
import type { HistoryFacts, Skill } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";

function skillRoots(ctx: SourceContext): string[] {
  // A Set because cwd can sit inside HOME (or be it) — auditing the same
  // directory twice would double every finding.
  return [...new Set([join(ctx.home, ".claude", "skills"), join(ctx.cwd, ".claude", "skills")])];
}

/**
 * Files sitting in an agents directory that are not agent definitions: no
 * frontmatter name, so Claude Code cannot register them and this tool does not
 * count them. Named rather than silently skipped — an unexplained gap between
 * "134 files on disk" and "110 agents" is its own kind of wrong number.
 */
function strayAgentFiles(ctx: SourceContext): string[] {
  const out: string[] = [];
  for (const root of new Set([join(ctx.home, ".claude", "agents"), join(ctx.cwd, ".claude", "agents")])) {
    for (const f of mdFilesUnder(root)) {
      if (!loadSkill(f).fmName) out.push(f.split("/").pop()!);
    }
  }
  return out.sort();
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

    // Agents dispatch on their frontmatter name (loadSkill already prefers it),
    // and a file WITHOUT one is not an agent at all — Claude Code cannot
    // register what it cannot name. Counting every .md in the directory turned
    // 23 files of somebody's repo documentation (README.md, CONTRIBUTING.md,
    // phase-*.md) into agents on the machine this was found on: a real
    // overcount of the inventory, reported instead as the thing it is.
    for (const root of new Set([
      join(ctx.home, ".claude", "agents"),
      join(ctx.cwd, ".claude", "agents"),
      // A disabled agent stays a row — grayed, history intact, excluded from
      // the per-session total — exactly as a disabled skill does.
      join(ctx.home, ".claude", "agents-disabled"),
    ])) {
      for (const f of mdFilesUnder(root)) {
        const fallback = f.split("/").pop()!.replace(/\.md$/, "");
        // A file with no frontmatter name is NOT an agent: Claude Code cannot
        // register what it cannot name, so nothing about it is ever loaded and
        // it costs nothing per session. It stays in the inventory anyway —
        // dropping it would turn ~/.claude/agents into a hiding place for an
        // injection payload the scanner never reads, which is the one thing
        // this tool must never do. It is priced at what it actually costs.
        const named = !!loadSkill(f).fmName;
        const asset = fileAsset(f, fallback, "claude", "agent", named ? "description" : "on-demand");
        if (named) asset.dirName = asset.fmName!;
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

    // Plugin-shipped assets. Claude Code loads these exactly like the ones you
    // wrote yourself — a marketplace pack's skills sit in the same listing and
    // pay the same per-session rent — so omitting them made every figure this
    // tool reports an undercount, and made the CLI disagree with its own
    // dashboard on the same machine.
    //
    // Only ENABLED installs, and only the versions Claude Code actually
    // resolved: the cache keeps every downloaded version side by side, and
    // auditing all of them would multiply the exact numbers the report exists
    // to get right. Note that one plugin CAN legitimately resolve to more than
    // one install — a user-scope and a project-scope entry are two live copies
    // — so the rule is one audit per distinct install on disk, not one per
    // plugin name.
    for (const install of resolveActivePlugins(ctx.home).installs) {
      if (!install.enabled) continue;
      for (const { skill } of discoverPluginAssets(install)) assets.push(skill);
    }

    return assets;
  },

  caveats(ctx) {
    // Plugin versions normally come from installed_plugins.json. When that file
    // is missing or unreadable the resolver falls back to newest-cached-version
    // per plugin, which is a guess — and now that plugin assets are part of the
    // CLI's cost, usage and security figures, a guessed version silently shapes
    // every number in the report. The dashboard has always shown this as a
    // caveat; the report cannot quietly present it as a measurement.
    // Counted over the installs that actually CONTRIBUTED — disabled ones are
    // not inventoried, so a caveat about them qualifies nothing and is just a
    // warning the reader cannot act on.
    const { installs, resolution } = resolveActivePlugins(ctx.home);
    const live = installs.filter((i) => i.enabled);
    const out: string[] = [];
    // Files sitting in an agents directory that are not agent definitions.
    // Skipping them silently would trade an overcount for an unexplained gap
    // between "134 files on disk" and "110 agents", and this tool states its
    // own degradations rather than leaving the reader to notice one.
    const stray = strayAgentFiles(ctx);
    if (stray.length > 0) {
      const shown = stray.slice(0, 6).join(", ");
      out.push(
        `${stray.length} file${stray.length === 1 ? "" : "s"} under ~/.claude/agents ${stray.length === 1 ? "is not an agent definition" : "are not agent definitions"}: ` +
          `no frontmatter name, so Claude Code cannot register ${stray.length === 1 ? "it" : "them"} and ${stray.length === 1 ? "it is" : "they are"} not counted here ` +
          `(${shown}${stray.length > 6 ? `, +${stray.length - 6} more` : ""}).`
      );
    }
    if (resolution === "newest-fallback" && live.length > 0) {
      out.push(
        `plugin versions resolved by newest-cached fallback (${live.length} plugin(s)) — ` +
          `installed_plugins.json was missing or unreadable, so which version is active is inferred, not read`
      );
    }
    // A plugin present at two install paths can only dispatch under one name,
    // so the figures describe one of them. Which one is a choice, and a choice
    // the reader cannot see is indistinguishable from a measurement.
    const ambiguous = live.filter((i) => (i.candidates ?? 1) > 1);
    for (const i of ambiguous) {
      out.push(
        `${i.name} is installed at ${i.candidates} paths — these figures describe ` +
          `version ${i.version} at ${i.root}; the others are not counted`
      );
    }
    return out;
  },

  async usage(ctx, assets): Promise<HistoryFacts> {
    // Only kinds the transcripts actually record dispatch for: Skill tool_use
    // and <command-name>. Passing agents or CLAUDE.md here would report them as
    // "never fired", which is a claim the data cannot support.
    const dispatchable = assets.filter((a) => a.kind === "skill" || a.kind === "command");
    return historyFacts(ctx.transcripts ?? join(ctx.home, ".claude", "projects"), dispatchable);
  },
};
