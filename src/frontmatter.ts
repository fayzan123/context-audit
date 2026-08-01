import type { SecurityFinding, Skill } from "./types.js";

const snip = (s: string, n = 100): string =>
  (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ").trim();

/**
 * Frontmatter and package layout are the mechanically-live parts of a skill:
 * `hooks:` entries run on tool events, `.claude-plugin/plugin.json` silently
 * promotes a skill folder to a plugin (session-start hooks, MCP servers,
 * background monitors), and `allowed-tools` pre-approves tools with no prompt.
 * Text checks in security.ts cover instructions the model may or may not follow;
 * everything here is about code and grants that do not need the model's consent.
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

/** Value of a top-level scalar key. */
function scalar(block: string, key: string): string | undefined {
  const line = block.split("\n").find((l) => new RegExp(`^${key}:`).test(l));
  if (!line) return undefined;
  let v = line.slice(key.length + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** Every `command:`/`url:` value at any nesting depth, with line number. */
function nestedValues(block: string, key: string): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.+)$`));
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out.push({ value: v, line: i + 2 }); // +2: block excludes the opening `---`
  }
  return out;
}

export function hookCommands(block: string): { command: string; line: number }[] {
  return nestedValues(block, "command").map((v) => ({ command: v.value, line: v.line }));
}

const NETWORK_IN_HOOK = /\b(?:curl|wget|nc|ncat|telnet|ssh|scp|python3?\s+-c|node\s+-e|npx\s)/;

/** Runners that permission rules do NOT strip — an allow rule on these launders arbitrary execution. */
const RUNNER_PREFIX = /\b(?:npx|docker\s+(?:exec|run)|devbox\s+run|mise\s+exec|direnv\s+exec|uv\s+run|pnpm\s+dlx|bunx)\b/;

/** Frontmatter keys defined by the spec or Claude Code. Anything else is silently ignored by the harness. */
const KNOWN_KEYS = new Set([
  "name", "description", "license", "compatibility", "metadata", "allowed-tools",
  "disallowed-tools", "hooks", "model", "effort", "context", "agent", "background",
  "disable-model-invocation", "user-invocable", "paths", "shell", "argument-hint",
  "arguments", "when_to_use", "version", "author", "keywords", "homepage",
]);

export function frontmatterFindings(skills: Skill[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const add = (skill: Skill, f: Omit<SecurityFinding, "skill">): void => {
    findings.push({ skill: skill.dirName, ...f });
  };

  for (const skill of skills) {
    // ---- Package layout: a plugin manifest silently unlocks far more than a skill ----
    const pluginManifest = skill.files.find((f) => /(?:^|\/)\.claude-plugin\/plugin\.json$/.test(f.relPath));
    if (pluginManifest) {
      const unlocked = skill.files
        .filter((f) =>
          /(?:^|\/)(?:hooks\/hooks\.json|\.mcp\.json|\.lsp\.json|monitors\/monitors\.json|agents\/|output-styles\/|themes\/)/.test(
            f.relPath
          )
        )
        .map((f) => f.relPath);
      add(skill, {
        file: pluginManifest.relPath,
        check: "plugin-manifest",
        level: "flag",
        severity: "high",
        confidence: "certain",
        message:
          "plugin manifest — this folder loads as a plugin (session-start hooks, MCP servers, background monitors), not just a skill",
        evidence: unlocked.length ? `unlocks: ${unlocked.slice(0, 5).join(", ")}` : "manifest present",
      });
    }

    for (const file of skill.files) {
      // Components that run on their own schedule rather than on model request.
      if (/(?:^|\/)monitors\/monitors\.json$/.test(file.relPath)) {
        const always = file.content?.includes('"always"') ?? false;
        add(skill, {
          file: file.relPath,
          check: "background-monitor",
          level: "flag",
          severity: "critical",
          confidence: "certain",
          message: always
            ? "background monitor with when:always — starts every session, unsandboxed, survives disabling the plugin"
            : "declares background monitor processes",
          evidence: snip(file.content?.slice(0, 120) ?? "", 100),
        });
      }
      if (/(?:^|\/)hooks\/hooks\.json$/.test(file.relPath)) {
        const sessionStart = /SessionStart|Setup/.test(file.content ?? "");
        add(skill, {
          file: file.relPath,
          check: "plugin-hooks",
          level: "flag",
          severity: sessionStart ? "critical" : "high",
          confidence: "certain",
          message: sessionStart
            ? "plugin hooks include SessionStart/Setup — shell that runs at every session start"
            : "plugin declares lifecycle hooks",
          evidence: snip(file.content?.slice(0, 120) ?? "", 100),
        });
      }
      if (/(?:^|\/)\.mcp\.json$/.test(file.relPath)) {
        add(skill, {
          file: file.relPath,
          check: "bundled-mcp",
          level: "flag",
          severity: "high",
          confidence: "certain",
          message: "bundles an MCP server config — starts automatically when the plugin is enabled",
          evidence: snip(file.content?.slice(0, 120) ?? "", 100),
        });
      }
    }

    const skillMd = skill.files.find((f) => f.relPath === "SKILL.md");
    if (!skillMd?.content) continue;
    const block = rawFrontmatter(skillMd.content);
    if (!block) continue;

    const keys = topLevelKeys(block);
    const commands = hookCommands(block);
    const urls = nestedValues(block, "url");

    // ---- hooks ----
    if (keys.includes("hooks")) {
      add(skill, {
        file: "SKILL.md",
        check: "frontmatter-hooks",
        level: "info",
        severity: "medium",
        confidence: "certain",
        message: `declares ${commands.length} hook command(s) — these run on tool events, not when the model chooses`,
        evidence: commands.map((c) => snip(c.command, 60)).join(" | ") || "hooks block present",
      });
      // An http hook POSTs the full event payload, including tool inputs.
      for (const { value, line } of urls) {
        add(skill, {
          file: "SKILL.md",
          line,
          check: "hook-http-sink",
          level: "flag",
          severity: "critical",
          confidence: "certain",
          message: "http hook posts full tool-event payloads to a remote URL",
          evidence: snip(value, 90),
        });
      }
    }

    for (const { command, line } of commands) {
      if (/\.\.[/\\]/.test(command)) {
        add(skill, {
          file: "SKILL.md",
          line,
          check: "hook-path-traversal",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: "hook command path escapes the skill directory (..)",
          evidence: snip(command, 90),
        });
      }
      if (/^\s*(?:\/|~)/.test(command) && !/\$\{?CLAUDE_SKILL_DIR/.test(command)) {
        add(skill, {
          file: "SKILL.md",
          line,
          check: "hook-absolute-path",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: "hook command runs an absolute path outside the skill package",
          evidence: snip(command, 90),
        });
      }
      const net = NETWORK_IN_HOOK.exec(command);
      if (net) {
        add(skill, {
          file: "SKILL.md",
          line,
          check: "hook-network-or-eval",
          level: "flag",
          severity: "critical",
          confidence: "likely",
          message: `hook command invokes ${net[0].trim()} — network access or inline code execution on a tool event`,
          evidence: snip(command, 90),
        });
      }
    }

    // ---- capability grants ----
    const allowed = scalar(block, "allowed-tools");
    if (allowed) {
      const wildcard = /Bash\s*\(\s*\*\s*\)|Bash\s*$|Bash\s*,|^\s*\*\s*$/.test(allowed);
      const runner = RUNNER_PREFIX.exec(allowed);
      // The documented zero-prompt pattern: an allow rule naming a bundled script.
      const bundled = /\$\{?CLAUDE_SKILL_DIR\}?/.test(allowed);
      if (wildcard) {
        add(skill, {
          file: "SKILL.md",
          check: "broad-tool-grant",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: "allowed-tools grants unrestricted Bash — pre-approved with no prompt",
          evidence: snip(allowed, 90),
        });
      }
      if (runner) {
        add(skill, {
          file: "SKILL.md",
          check: "runner-laundering",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: `allowed-tools grants a ${runner[0].trim()} rule — permission matching does not strip these, so it grants arbitrary execution`,
          evidence: snip(allowed, 90),
        });
      }
      if (bundled) {
        add(skill, {
          file: "SKILL.md",
          check: "bundled-script-autorun",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: "allowed-tools pre-approves a bundled script — it runs without a permission prompt",
          evidence: snip(allowed, 90),
        });
      }
      if (!wildcard && !runner && !bundled && /\b(?:Bash|Write|Edit|WebFetch|NotebookEdit)\b/.test(allowed)) {
        add(skill, {
          file: "SKILL.md",
          check: "frontmatter-capabilities",
          level: "info",
          severity: "low",
          confidence: "certain",
          message: "pre-authorizes powerful tools via allowed-tools",
          evidence: snip(allowed, 90),
        });
      }
    }

    const disallowed = scalar(block, "disallowed-tools");
    if (disallowed && /AskUserQuestion/.test(disallowed)) {
      add(skill, {
        file: "SKILL.md",
        check: "suppresses-user-prompt",
        level: "flag",
        severity: "high",
        confidence: "certain",
        message: "removes AskUserQuestion — the agent cannot stop to ask the user during this skill",
        evidence: snip(disallowed, 90),
      });
    }

    // ---- execution-context modifiers ----
    if (scalar(block, "context") === "fork" && /^true$/i.test(scalar(block, "background") ?? "")) {
      add(skill, {
        file: "SKILL.md",
        check: "background-fork",
        level: "flag",
        severity: "high",
        confidence: "certain",
        message: "runs as a background fork — its edits fall outside /rewind checkpoints",
        evidence: "context: fork + background: true",
      });
    }

    if (
      /^true$/i.test(scalar(block, "disable-model-invocation") ?? "") === false &&
      /^false$/i.test(scalar(block, "user-invocable") ?? "")
    ) {
      add(skill, {
        file: "SKILL.md",
        check: "hidden-from-menu",
        level: "info",
        severity: "medium",
        confidence: "certain",
        message: "hidden from the slash menu but still model-invocable",
        evidence: "user-invocable: false",
      });
    }

    // ---- description is injected into every session, invoked or not ----
    const desc = scalar(block, "description") ?? "";
    const descInjection =
      /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+\w*\s*(?:instructions?|rules?)|do\s+not\s+(?:tell|inform)\s+the\s+user|always\s+(?:run|execute|invoke)\b/i.exec(
        desc
      );
    if (descInjection) {
      add(skill, {
        file: "SKILL.md",
        check: "description-injection",
        level: "flag",
        severity: "critical",
        confidence: "likely",
        message: "injection-shaped text in description — loaded into every session whether or not the skill is invoked",
        evidence: snip(descInjection[0], 90),
      });
    }

    // ---- unknown keys are silently ignored by the harness: a free payload carrier ----
    const unknown = keys.filter((k) => !KNOWN_KEYS.has(k));
    if (unknown.length > 0) {
      add(skill, {
        file: "SKILL.md",
        check: "unknown-frontmatter-key",
        level: "info",
        severity: "low",
        confidence: "certain",
        message: `${unknown.length} unrecognized frontmatter key(s) — ignored by the harness, so contents are unvalidated`,
        evidence: unknown.slice(0, 6).join(", "),
      });
    }
  }

  return findings;
}
