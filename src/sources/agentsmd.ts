import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "../types.js";
import type { SourceAdapter } from "./types.js";
import { fileAsset } from "../skills.js";

/**
 * AGENTS.md is a cross-tool standard: Codex, Cursor, OpenCode and others all
 * read the same file. It is audited by its own source exactly once — if every
 * adapter that honors it claimed it, one file would repeat its findings once
 * per installed tool.
 */
export const agentsMdAdapter: SourceAdapter = {
  id: "agents-md",

  detect(ctx) {
    return existsSync(join(ctx.cwd, "AGENTS.md")) || existsSync(join(ctx.home, "AGENTS.md"));
  },

  discover(ctx) {
    const assets: Skill[] = [];
    const seen = new Set<string>();
    const candidates: [string, string][] = [
      [join(ctx.cwd, "AGENTS.md"), "AGENTS.md"],
      [join(ctx.home, "AGENTS.md"), "~/AGENTS.md"],
    ];
    for (const [path, name] of candidates) {
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      // cwd may BE home; the same file must not be audited twice.
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      assets.push(fileAsset(path, name, "agents-md", "instructions", "body"));
    }
    return assets;
  },
};
