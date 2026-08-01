import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { Skill, SkillFile } from "./types.js";

const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  let suspect = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspect++;
  }
  return sample.length === 0 || suspect / sample.length < 0.05;
}

function collectFiles(root: string, dir: string, out: SkillFile[], seen = new Set<string>()): void {
  try {
    const real = realpathSync(dir);
    if (seen.has(real)) return; // symlink cycle
    seen.add(real);
  } catch {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = join(dir, entry.name);
    // statSync follows symlinks — skills directories commonly symlink into repos.
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue; // broken symlink
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(root, absPath, out, seen);
      continue;
    }
    if (!stat.isFile()) continue;
    const bytes = stat.size;
    const file: SkillFile = { relPath: relative(root, absPath), absPath, bytes };
    if (bytes <= MAX_FILE_BYTES) {
      const buf = readFileSync(absPath);
      if (isProbablyText(buf)) file.content = buf.toString("utf8");
    }
    out.push(file);
  }
}

/** Minimal frontmatter parser: single-line `key: value` pairs between the first `---` fence pair. */
export function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!md.startsWith("---")) return { fm, body: md };
  const end = md.indexOf("\n---", 3);
  if (end === -1) return { fm, body: md };
  const block = md.slice(md.indexOf("\n") + 1, end);
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      // Block scalar: consume the following more-indented lines.
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  const body = md.slice(end + 4).replace(/^\r?\n/, "");
  return { fm, body };
}

/** Load a single skill from a directory containing SKILL.md (or a bare .md file). */
export function loadSkill(path: string): Skill {
  const stat = statSync(path);
  if (stat.isFile()) {
    const content = readFileSync(path, "utf8");
    const { fm, body } = parseFrontmatter(content);
    return {
      dirName: fm["name"] ?? path.split("/").pop()!.replace(/\.md$/, ""),
      dir: path,
      fmName: fm["name"],
      description: fm["description"],
      body,
      files: [{ relPath: path.split("/").pop()!, absPath: path, content, bytes: stat.size }],
      hasSkillMd: true,
    };
  }
  const files: SkillFile[] = [];
  collectFiles(path, path, files);
  const skillMd = files.find((f) => f.relPath === "SKILL.md");
  const dirName = path.replace(/\/+$/, "").split("/").pop()!;
  if (!skillMd?.content) {
    return { dirName, dir: path, body: "", files, hasSkillMd: false };
  }
  const { fm, body } = parseFrontmatter(skillMd.content);
  return {
    dirName,
    dir: path,
    fmName: fm["name"],
    description: fm["description"],
    body,
    files,
    hasSkillMd: true,
  };
}

/** Discover all skills in a skills directory (each subdirectory with a SKILL.md). */
export function discoverSkills(dir: string): Skill[] {
  if (!existsSync(dir)) throw new Error(`skills directory not found: ${dir}`);
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = statSync(path); // follows symlinks
    } catch {
      continue;
    }
    if (stat.isDirectory() || (stat.isFile() && entry.name.endsWith(".md"))) {
      skills.push(loadSkill(path));
    }
  }
  return skills.sort((a, b) => a.dirName.localeCompare(b.dirName));
}
