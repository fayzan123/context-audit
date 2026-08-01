#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { discoverSkills, loadSkill } from "./skills.js";
import { contentFacts } from "./content.js";
import { securityScan } from "./security.js";
import { historyFacts } from "./history.js";
import { printJson, printReport } from "./report.js";
import type { AuditResult } from "./types.js";

const HELP = `skill-audit — npm audit for agent skills. Facts, not judgment.

Usage:
  skill-audit [dir]              audit a skills directory (default: ~/.claude/skills)
  skill-audit scan <path>        pre-install scan of a single skill (dir or .md file);
                                 content + security only, no history

Options:
  --json                machine-readable output
  --no-history          skip the local transcript scan
  --transcripts <dir>   transcript location (default: ~/.claude/projects)
  -h, --help            this help

Exit codes: 0 = no security flags · 1 = at least one security flag · 2 = usage error

Everything runs locally. Nothing leaves the machine.`;

interface Args {
  command: "audit" | "scan";
  target?: string;
  json: boolean;
  history: boolean;
  transcripts: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "audit",
    json: false,
    history: true,
    transcripts: join(homedir(), ".claude", "projects"),
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "--json") args.json = true;
    else if (a === "--no-history") args.history = false;
    else if (a === "--transcripts") {
      const v = argv[++i];
      if (!v) fail("--transcripts requires a directory");
      args.transcripts = resolve(v);
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
  console.error(`skill-audit: ${msg}`);
  console.error(`run with --help for usage`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "scan") {
    const target = resolve(args.target!);
    if (!existsSync(target)) fail(`not found: ${target}`);
    const skills = [loadSkill(target)];
    const result: AuditResult = {
      dir: target,
      content: contentFacts(skills),
      security: securityScan(skills),
    };
    (args.json ? printJson : printReport)(result);
    // exitCode, not exit(): exit() truncates piped stdout before it flushes.
    process.exitCode = result.security.some((f) => f.level === "flag") ? 1 : 0;
    return;
  }

  const dir = resolve(args.target ?? join(homedir(), ".claude", "skills"));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`skills directory not found: ${dir}`);

  const skills = discoverSkills(dir);
  const result: AuditResult = {
    dir,
    content: contentFacts(skills),
    security: securityScan(skills),
  };
  if (args.history) {
    result.history = await historyFacts(args.transcripts, skills);
  }
  (args.json ? printJson : printReport)(result);
  process.exitCode = result.security.some((f) => f.level === "flag") ? 1 : 0;
}

main().catch((err) => {
  console.error(`skill-audit: ${err?.message ?? err}`);
  process.exit(2);
});
