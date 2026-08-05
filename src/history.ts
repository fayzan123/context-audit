import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { HistoryFacts, Skill, SkillUsage } from "./types.js";

interface Invocation {
  skill: string;
  file: string;
  lineNo: number;
  timestamp?: string;
}

/** An interrupt this many lines or fewer after an invocation is attributed to it. */
const INTERRUPT_WINDOW = 15;

export function findJsonlFiles(dir: string): string[] {
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
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export const TS_RE = /"timestamp"\s*:\s*"([^"]+)"/;
const COMMAND_RE = /<command-name>\/?([A-Za-z0-9:_-]+)<\/command-name>/;

function extractSkillInvocations(line: string): string[] {
  // Fast reject before JSON.parse — most lines have no Skill tool_use.
  if (!line.includes('"name":"Skill"') && !line.includes('"name": "Skill"')) return [];
  try {
    const obj = JSON.parse(line);
    const content = obj?.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((b: any) => b?.type === "tool_use" && b?.name === "Skill" && typeof b?.input?.skill === "string")
      .map((b: any) => b.input.skill as string);
  } catch {
    return [];
  }
}

export async function historyFacts(transcriptsDir: string, skills: Skill[]): Promise<HistoryFacts> {
  const files = existsSync(transcriptsDir) ? findJsonlFiles(transcriptsDir) : [];
  const invocations: Invocation[] = [];
  const interruptedInvocations = new Set<Invocation>();
  let windowStart: string | undefined;
  let windowEnd: string | undefined;

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    let lineNo = 0;
    const recent: Invocation[] = [];
    for await (const line of rl) {
      lineNo++;
      const ts = TS_RE.exec(line)?.[1];
      if (ts) {
        if (!windowStart || ts < windowStart) windowStart = ts;
        if (!windowEnd || ts > windowEnd) windowEnd = ts;
      }

      for (const skillName of extractSkillInvocations(line)) {
        const inv: Invocation = { skill: skillName, file, lineNo, timestamp: ts };
        invocations.push(inv);
        recent.push(inv);
      }
      const cmd = COMMAND_RE.exec(line);
      if (cmd) {
        const inv: Invocation = { skill: cmd[1], file, lineNo, timestamp: ts };
        invocations.push(inv);
        recent.push(inv);
      }

      if (line.includes("[Request interrupted") && line.includes('"type":"user"')) {
        for (const inv of recent) {
          if (lineNo - inv.lineNo <= INTERRUPT_WINDOW) interruptedInvocations.add(inv);
        }
      }
      while (recent.length > 0 && lineNo - recent[0].lineNo > INTERRUPT_WINDOW) recent.shift();
    }
  }

  const bySkill = new Map<string, Invocation[]>();
  for (const inv of invocations) {
    bySkill.set(inv.skill, [...(bySkill.get(inv.skill) ?? []), inv]);
  }

  const toUsage = (name: string, invs: Invocation[]): SkillUsage => {
    const stamps = invs
      .map((i) => i.timestamp)
      .filter((t): t is string => !!t)
      .sort();
    return {
      skill: name,
      invocations: invs.length,
      sessions: new Set(invs.map((i) => i.file)).size,
      firstFired: stamps[0],
      lastFired: stamps[stamps.length - 1],
      interruptedAfter: invs.filter((i) => interruptedInvocations.has(i)).length,
    };
  };

  const installed = new Set(skills.map((s) => s.dirName));
  const usage: SkillUsage[] = [];
  const external: SkillUsage[] = [];
  for (const [name, invs] of bySkill) {
    (installed.has(name) ? usage : external).push(toUsage(name, invs));
  }
  usage.sort((a, b) => b.invocations - a.invocations);
  external.sort((a, b) => b.invocations - a.invocations);

  return {
    transcriptFiles: files.length,
    windowStart,
    windowEnd,
    usage,
    neverFired: skills.map((s) => s.dirName).filter((n) => !bySkill.has(n)).sort(),
    external,
  };
}
