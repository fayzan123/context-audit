import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { discoverSkills, fileAsset, loadSkill, mdFilesUnder } from "../skills.js";
import { discoverPluginAssets, resolveActivePlugins } from "../plugins.js";
import { historyFacts } from "../history.js";
import { securityScan } from "../security.js";
import type { HistoryFacts, Skill } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";

function skillRoots(ctx: SourceContext): string[] {
  // A Set because cwd can sit inside HOME (or be it) — auditing the same
  // directory twice would double every finding.
  return [...new Set([join(ctx.home, ".claude", "skills"), join(ctx.cwd, ".claude", "skills")])];
}

/**
 * The directories an agent can be registered from. ONE list, read by both
 * `discover` and `caveats`: the caveat says the unnamed files are "not counted
 * here" and discovery is what makes that true, so a root either side walked
 * alone is a root where the two disagree — which is exactly how 23 files of
 * somebody's repo documentation came to be counted as agents underneath a
 * caveat promising they were not.
 *
 * `agents-disabled` is included because a disabled agent stays a row: the
 * sibling directory Claude Code does not read, not a different kind of asset.
 */
function agentRoots(ctx: SourceContext): Set<string> {
  return new Set([
    join(ctx.home, ".claude", "agents"),
    join(ctx.cwd, ".claude", "agents"),
    join(ctx.home, ".claude", "agents-disabled"),
  ]);
}

/**
 * Files sitting in an agents directory that are not agent definitions: no
 * frontmatter name, so Claude Code cannot register them and this tool does not
 * count them. Named rather than silently skipped — an unexplained gap between
 * "134 files on disk" and "110 agents" is its own kind of wrong number.
 */
function strayAgentAssets(ctx: SourceContext): Skill[] {
  const out: Skill[] = [];
  for (const root of agentRoots(ctx)) {
    for (const f of mdFilesUnder(root)) {
      if (loadSkill(f).fmName) continue;
      out.push(fileAsset(f, f.split("/").pop()!.replace(/\.md$/, ""), "claude", "agent", "on-demand"));
    }
  }
  return out.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
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
    // A disabled agent stays a row — grayed, history intact, excluded from the
    // per-session total — exactly as a disabled skill does, so its directory is
    // walked here too (see agentRoots).
    for (const root of agentRoots(ctx)) {
      for (const f of mdFilesUnder(root)) {
        // A file with no frontmatter name is NOT an agent and does not become
        // an item: Claude Code cannot register what it cannot name, so it can
        // never be dispatched and never fires. Counting it produced a row that
        // could only ever read "never used" — 23 of them on the machine this
        // was found on (README, CONTRIBUTING, phase-0-discovery), inflating the
        // one number this tool exists to explain, and directly contradicting
        // the caveat below that says they are not counted. They carry no
        // injected chars, so no cost figure moves when they go.
        const fmName = loadSkill(f).fmName;
        if (!fmName) continue;
        const asset = fileAsset(f, f.split("/").pop()!.replace(/\.md$/, ""), "claude", "agent", "description");
        asset.dirName = asset.fmName!;
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

  scanOnly: strayAgentAssets,

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
    const strayAssets = strayAgentAssets(ctx);
    const stray = strayAssets.map((s) => s.dirName + ".md");
    if (stray.length > 0) {
      const shown = stray.slice(0, 6).join(", ");
      // "Not counted" must never be read as "not looked at". These files are
      // out of the inventory and out of every cost and usage figure, and they
      // are still handed to the security engine (SourceAdapter.scanOnly) — so
      // where one of them actually carries a payload, the caveat that removed
      // it from the count is also what says so. Only stated when true: a
      // reassurance printed on every clean machine is noise.
      const flagged = strayAssets.filter((s) => securityScan([s], false).some((f) => f.level === "flag"));
      out.push(
        `${stray.length} file${stray.length === 1 ? "" : "s"} under ~/.claude/agents ${stray.length === 1 ? "is not an agent definition" : "are not agent definitions"}: ` +
          `no frontmatter name, so Claude Code cannot register ${stray.length === 1 ? "it" : "them"} and ${stray.length === 1 ? "it is" : "they are"} not counted here ` +
          `(${shown}${stray.length > 6 ? `, +${stray.length - 6} more` : ""})` +
          (flagged.length > 0
            ? ` — still scanned, and ${flagged.length === 1 ? "one of them flags" : `${flagged.length} of them flag`}: ` +
              `${flagged.map((s) => s.dirName + ".md").join(", ")}.`
            : ".")
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
    // Only kinds the transcripts actually record dispatch for: Skill tool_use,
    // <command-name>, and the `Agent`/`Task` tool_use that names its
    // `subagent_type`. Agents were excluded here while that third channel was
    // being discarded at the name gate — reporting them as "never fired" was a
    // claim the data could not support, because nothing was reading the data.
    // It is read now, so the honest move is the opposite one: leaving agents
    // out would report every launch as no launch at all. CLAUDE.md stays out —
    // an instruction file is loaded, never dispatched.
    const dispatchable = assets.filter((a) => a.kind === "skill" || a.kind === "command" || a.kind === "agent");
    return historyFacts(ctx.transcripts ?? join(ctx.home, ".claude", "projects"), dispatchable);
  },
};
