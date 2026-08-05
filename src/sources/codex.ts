import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { findJsonlFiles, TS_RE } from "../history.js";
import type { HistoryFacts, Skill, SkillUsage } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";
import { fileAsset, mdFilesUnder } from "../skills.js";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Codex rollout files record user turns as JSON lines. A prompt fires as a
 * slash command inside the user's text, so the honest signal available is
 * "/name appeared in a user line" — counted per line, attributed per file
 * (one rollout file = one session). Model output is excluded: an assistant
 * merely *mentioning* /ship must not count as the user invoking it.
 */
function isUserLine(line: string): boolean {
  return line.includes('"role":"user"') || line.includes('"user_message"');
}

export const codexAdapter: SourceAdapter = {
  id: "codex",

  detect(ctx) {
    return existsSync(join(ctx.home, ".codex"));
  },

  discover(ctx) {
    const assets: Skill[] = [];
    const agentsMd = join(ctx.home, ".codex", "AGENTS.md");
    if (existsSync(agentsMd) && statSync(agentsMd).isFile()) {
      // Global instructions: the whole body rides along in every session.
      assets.push(fileAsset(agentsMd, "~/.codex/AGENTS.md", "codex", "instructions", "body"));
    }
    for (const f of mdFilesUnder(join(ctx.home, ".codex", "prompts"))) {
      // Prompts are user-invoked slash commands: only the name is listed until
      // one fires, so the name is the always-paid cost.
      const name = f.split("/").pop()!.replace(/\.md$/, "");
      assets.push(fileAsset(f, name, "codex", "prompt", "name-only"));
    }
    return assets;
  },

  async usage(ctx, assets): Promise<HistoryFacts> {
    const files = findJsonlFiles(join(ctx.home, ".codex", "sessions"));
    const prompts = assets.filter((a) => a.kind === "prompt");
    const patterns = prompts.map((p) => ({
      name: p.dirName,
      // Boundary on both sides: "/ship please" hits, "path/to/shipment" does not.
      re: new RegExp(`(?:^|[\\s"'\`(:])/${escapeRe(p.dirName)}(?![\\w-])`),
    }));

    let windowStart: string | undefined;
    let windowEnd: string | undefined;
    const hits = new Map<
      string,
      { invocations: number; sessions: Set<string>; firstFired?: string; lastFired?: string }
    >();

    for (const file of files) {
      const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
      for await (const line of rl) {
        const ts = TS_RE.exec(line)?.[1];
        if (ts) {
          if (!windowStart || ts < windowStart) windowStart = ts;
          if (!windowEnd || ts > windowEnd) windowEnd = ts;
        }
        if (!isUserLine(line)) continue;
        for (const p of patterns) {
          if (!p.re.test(line)) continue;
          const h = hits.get(p.name) ?? { invocations: 0, sessions: new Set<string>() };
          h.invocations++;
          h.sessions.add(file);
          if (ts && (!h.lastFired || ts > h.lastFired)) h.lastFired = ts;
          if (ts && (!h.firstFired || ts < h.firstFired)) h.firstFired = ts;
          hits.set(p.name, h);
        }
      }
    }

    const usage: SkillUsage[] = [...hits.entries()]
      .map(([skill, h]) => ({
        skill,
        invocations: h.invocations,
        sessions: h.sessions.size,
        firstFired: h.firstFired,
        lastFired: h.lastFired,
        // Rollouts don't record interrupts in a parseable way; zero, not a guess.
        interruptedAfter: 0,
      }))
      .sort((a, b) => b.invocations - a.invocations);

    return {
      transcriptFiles: files.length,
      windowStart,
      windowEnd,
      usage,
      neverFired: prompts.map((p) => p.dirName).filter((n) => !hits.has(n)).sort(),
      external: [],
    };
  },
};
