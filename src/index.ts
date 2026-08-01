#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { discoverSkills, loadSkill } from "./skills.js";
import { contentFacts } from "./content.js";
import { securityScan } from "./security.js";
import { historyFacts } from "./history.js";
import { printAgent, printJson, printReport } from "./report.js";
import { ADAPTERS, SOURCE_IDS, auditSource } from "./sources/index.js";
import type { SourceContext } from "./sources/index.js";
import type { AuditResult, MultiAuditResult, Skill, SourceAudit, SourceId } from "./types.js";

const HELP = `context-audit — npm audit for agent instructions. Facts, not judgment.

Audits the instruction files your AI coding tools execute — Claude Code
skills/agents/commands/CLAUDE.md, Codex prompts and AGENTS.md, Cursor rules,
and the cross-tool AGENTS.md standard. One run, every tool on the machine.

Usage:
  context-audit                  detect every supported tool (via $HOME and the
                                 current directory) and audit all of them
  context-audit [dir]            audit one claude-format skills directory
  context-audit scan <path>      pre-install scan of a single skill (dir or .md
                                 file); content + security only, no history

Options:
  --source <ids>        audit only these sources (comma-separated:
                        ${SOURCE_IDS.join(", ")})
  --strict              also gate on capability grants (allowed-tools: Bash and
                        friends). Always on for \`scan\` — before you install
                        something, what it is allowed to do is the whole question.
  --agent               compact JSON for AI agents (flags in full, noise aggregated)
  --json                full machine-readable output
  --no-history          skip local transcript scans
  --transcripts <dir>   Claude transcript location (default: ~/.claude/projects)
  -h, --help            this help

Exit codes: 0 = no security flags · 1 = at least one security flag · 2 = usage error

Everything runs locally. Nothing leaves the machine.`;

interface Args {
  command: "audit" | "scan";
  target?: string;
  output: "report" | "json" | "agent";
  history: boolean;
  transcripts?: string;
  strict: boolean;
  sources?: SourceId[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "audit",
    output: "report",
    history: true,
    strict: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "--json") args.output = "json";
    else if (a === "--agent") args.output = "agent";
    else if (a === "--no-history") args.history = false;
    else if (a === "--strict") args.strict = true;
    else if (a === "--transcripts") {
      const v = argv[++i];
      if (!v) fail("--transcripts requires a directory");
      args.transcripts = resolve(v);
    } else if (a === "--source") {
      const v = argv[++i];
      if (!v) fail(`--source requires a comma-separated list of: ${SOURCE_IDS.join(", ")}`);
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      for (const id of ids) {
        if (!SOURCE_IDS.includes(id as SourceId)) {
          fail(`unknown source: ${id} (known: ${SOURCE_IDS.join(", ")})`);
        }
      }
      args.sources = ids as SourceId[];
    } else if (a.startsWith("-")) fail(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional[0] === "scan") {
    args.command = "scan";
    args.target = positional[1];
    if (!args.target) fail("scan requires a path to a skill directory or .md file");
  } else {
    args.target = positional[0];
  }
  return args;
}

function fail(msg: string): never {
  console.error(`context-audit: ${msg}`);
  console.error(`run with --help for usage`);
  process.exit(2);
}

const hasFlags = (sources: SourceAudit[]): boolean =>
  sources.some((s) => s.security.some((f) => f.level === "flag"));

function toSourceAudit(source: SourceId, skills: Skill[], strict: boolean): SourceAudit {
  return {
    source,
    assets: skills.map((s) => ({ name: s.dirName, kind: s.kind ?? "skill", path: s.dir })),
    content: contentFacts(skills),
    security: securityScan(skills, strict),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx: SourceContext = { home: homedir(), cwd: process.cwd(), transcripts: args.transcripts };

  if (args.command === "scan") {
    const target = resolve(args.target!);
    if (!existsSync(target)) fail(`not found: ${target}`);
    const skills = [loadSkill(target)];
    // Pre-install: capability grants are the decision, so never relax them.
    const legacy: AuditResult = {
      dir: target,
      content: contentFacts(skills),
      security: securityScan(skills, true),
    };
    // The scan JSON shape is the tool's oldest contract; it stays byte-stable.
    if (args.output === "json") printJson(legacy);
    else print(args.output, { sources: [toSourceAudit("custom", skills, true)] });
    // exitCode, not exit(): exit() truncates piped stdout before it flushes.
    process.exitCode = legacy.security.some((f) => f.level === "flag") ? 1 : 0;
    return;
  }

  let sources: SourceAudit[];
  if (args.target) {
    // Explicit directory: the original single-directory audit, now one source.
    const dir = resolve(args.target);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`skills directory not found: ${dir}`);
    const skills = discoverSkills(dir).map((s) => ({ ...s, source: "custom" as const }));
    const audit = toSourceAudit("custom", skills, args.strict);
    if (args.history) {
      audit.history = await historyFacts(
        args.transcripts ?? join(ctx.home, ".claude", "projects"),
        skills
      );
    }
    sources = [audit];
  } else {
    const wanted = ADAPTERS.filter((a) => !args.sources || args.sources.includes(a.id));
    const detected = wanted.filter((a) => a.detect(ctx));
    if (detected.length === 0) {
      fail(
        args.sources
          ? `none of the requested sources are present on this machine`
          : `no supported agent tools detected (looked for ~/.claude, ~/.codex, .cursor/rules, .cursorrules, AGENTS.md)`
      );
    }
    const audits = await Promise.all(
      detected.map((a) => auditSource(a, ctx, { history: args.history, strict: args.strict }))
    );
    // A tool whose directory exists but holds no instruction assets has nothing
    // to say; keeping the empty section would just pad the report.
    sources = audits.filter((s) => s.assets.length > 0);
    if (sources.length === 0) fail(`detected tools but found no instruction assets to audit`);
  }

  const result: MultiAuditResult = { sources };
  print(args.output, result);
  process.exitCode = hasFlags(sources) ? 1 : 0;
}

function print(output: Args["output"], result: MultiAuditResult): void {
  if (output === "json") printJson(result);
  else if (output === "agent") printAgent(result);
  else printReport(result);
}

main().catch((err) => {
  console.error(`context-audit: ${err?.message ?? err}`);
  process.exit(2);
});
