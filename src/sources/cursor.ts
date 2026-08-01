import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../skills.js";
import type { Injection, Skill } from "../types.js";
import type { SourceAdapter, SourceContext } from "./types.js";

/** Every rule file under .cursor/rules, recursively — nested rule dirs are a thing in monorepos. */
function ruleFiles(dir: string): string[] {
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
        stat = statSync(p);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile() && /\.(mdc|md)$/.test(entry.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function ruleAsset(path: string): Skill {
  const content = readFileSync(path, "utf8");
  const { fm, body } = parseFrontmatter(content);
  // Cursor's cost model: alwaysApply rules ride whole in every prompt;
  // agent-requested rules pay their description so the model can pick them;
  // glob/manual rules cost nothing until they trigger.
  const injection: Injection =
    fm["alwaysApply"] === "true" ? "body" : fm["description"]?.trim() ? "description" : "on-demand";
  return {
    dirName: basename(path).replace(/\.(mdc|md)$/, ""),
    dir: path,
    fmName: fm["name"],
    description: fm["description"],
    body,
    files: [{ relPath: basename(path), absPath: path, content, bytes: Buffer.byteLength(content) }],
    hasSkillMd: true,
    source: "cursor",
    kind: "rule",
    injection,
  };
}

export const cursorAdapter: SourceAdapter = {
  id: "cursor",

  detect(ctx) {
    return existsSync(join(ctx.cwd, ".cursor", "rules")) || existsSync(join(ctx.cwd, ".cursorrules"));
  },

  discover(ctx) {
    const assets: Skill[] = [];
    for (const f of ruleFiles(join(ctx.cwd, ".cursor", "rules"))) assets.push(ruleAsset(f));

    const legacy = join(ctx.cwd, ".cursorrules");
    if (existsSync(legacy) && statSync(legacy).isFile()) {
      const content = readFileSync(legacy, "utf8");
      assets.push({
        dirName: ".cursorrules",
        dir: legacy,
        body: content,
        files: [{ relPath: ".cursorrules", absPath: legacy, content, bytes: Buffer.byteLength(content) }],
        hasSkillMd: true,
        source: "cursor",
        kind: "rule",
        // The legacy file has no frontmatter and no scoping: always applied.
        injection: "body",
      });
    }
    return assets;
  },

  // No `usage`: Cursor keeps its history in an undocumented SQLite store.
  // Absent data stays absent rather than becoming a guess.
};
