import type { SecurityFinding, Skill } from "./types.js";

const snip = (s: string, n = 100): string =>
  (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ").trim();

/**
 * Frontmatter is the mechanically-live part of a skill: `hooks:` entries run on
 * tool events without the model deciding anything, and capability fields
 * pre-authorize tools. Text checks in security.ts only cover instructions the
 * model may or may not follow — these findings are about code that just runs.
 */

/** Raw frontmatter block, or "" when absent. */
export function rawFrontmatter(md: string): string {
  if (!md.startsWith("---")) return "";
  const end = md.indexOf("\n---", 3);
  if (end === -1) return "";
  return md.slice(md.indexOf("\n") + 1, end);
}

/** Top-level keys, in order, from a frontmatter block. */
export function topLevelKeys(block: string): string[] {
  const keys: string[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Every `command:` value at any nesting depth, with its line number within the block. */
export function hookCommands(block: string): { command: string; line: number }[] {
  const out: { command: string; line: number }[] = [];
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:-\s*)?command:\s*(.+)$/);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out.push({ command: v, line: i + 2 }); // +2: block excludes the opening `---`
  }
  return out;
}

const NETWORK_IN_HOOK = /\b(?:curl|wget|nc|ncat|telnet|ssh|scp|python3?\s+-c|node\s+-e|npx\s)/;

export function frontmatterFindings(skills: Skill[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const skill of skills) {
    const skillMd = skill.files.find((f) => f.relPath === "SKILL.md");
    if (!skillMd?.content) continue;
    const block = rawFrontmatter(skillMd.content);
    if (!block) continue;

    const keys = topLevelKeys(block);
    const commands = hookCommands(block);

    if (keys.includes("hooks")) {
      findings.push({
        skill: skill.dirName,
        file: "SKILL.md",
        check: "frontmatter-hooks",
        level: "info",
        message: `declares ${commands.length} hook command(s) — these run on tool events, not when the model chooses`,
        evidence: commands.map((c) => snip(c.command, 60)).join(" | ") || "hooks block present",
      });
    }

    for (const { command, line } of commands) {
      // A hook whose command escapes the skill's own directory runs code the
      // skill does not ship — legitimate for skill suites, and the exact shape
      // used to execute someone else's script.
      if (/\.\.[/\\]/.test(command)) {
        findings.push({
          skill: skill.dirName,
          file: "SKILL.md",
          line,
          check: "hook-path-traversal",
          level: "flag",
          message: "hook command path escapes the skill directory (..)",
          evidence: snip(command, 90),
        });
      }
      if (/^\s*(?:\/|~)/.test(command) && !/\$\{?CLAUDE_SKILL_DIR/.test(command)) {
        findings.push({
          skill: skill.dirName,
          file: "SKILL.md",
          line,
          check: "hook-absolute-path",
          level: "flag",
          message: "hook command runs an absolute path outside the skill package",
          evidence: snip(command, 90),
        });
      }
      const net = NETWORK_IN_HOOK.exec(command);
      if (net) {
        findings.push({
          skill: skill.dirName,
          file: "SKILL.md",
          line,
          check: "hook-network-or-eval",
          level: "flag",
          message: `hook command invokes ${net[0].trim()} — network access or inline code execution on a tool event`,
          evidence: snip(command, 90),
        });
      }
    }

    // Capability fields: report what the skill grants itself, as a fact.
    const toolsLine = block.split("\n").find((l) => /^allowed-tools:/.test(l));
    if (toolsLine) {
      const value = toolsLine.replace(/^allowed-tools:\s*/, "").trim();
      const powerful = /\b(?:Bash|Write|Edit|WebFetch|NotebookEdit)\b/.exec(value);
      if (value !== "" && powerful) {
        findings.push({
          skill: skill.dirName,
          file: "SKILL.md",
          check: "frontmatter-capabilities",
          level: "info",
          message: "pre-authorizes powerful tools via allowed-tools",
          evidence: snip(value, 90),
        });
      }
    }
  }

  return findings;
}
