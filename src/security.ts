import type { SecurityFinding, Skill } from "./types.js";
import { frontmatterFindings } from "./frontmatter.js";

const snip = (s: string, n = 100): string =>
  (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ").trim();

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** True when the match sits on a line that is (lexically) a comment — reported as part of the fact. */
function onCommentLine(content: string, index: number): boolean {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", start);
  if (end === -1) end = content.length;
  return /^\s*(?:#|\/\/|\*|<!--|;)/.test(content.slice(start, end));
}

interface Check {
  id: string;
  run(skill: Skill, file: string, content: string, findings: SecurityFinding[]): void;
}

/** Phrases with documented prompt-injection semantics. Pattern list, not judgment. */
const INJECTION_PHRASES: { re: RegExp; label: string }[] = [
  { re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i, label: "instruction override" },
  { re: /disregard\s+(?:all\s+)?(?:previous|prior|your)\s+(?:instructions|rules|guidelines)/i, label: "instruction override" },
  { re: /do\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to|alert|notify)\s+the\s+user/i, label: "concealment directive" },
  { re: /don'?t\s+(?:tell|inform|show|mention\s+(?:this\s+)?to)\s+the\s+user/i, label: "concealment directive" },
  { re: /without\s+(?:informing|telling|notifying|asking)\s+the\s+user/i, label: "concealment directive" },
  { re: /hide\s+this\s+from/i, label: "concealment directive" },
  { re: /do\s+not\s+(?:mention|reveal|disclose)\s+(?:this|these\s+instructions)/i, label: "concealment directive" },
  { re: /before\s+doing\s+anything\s+else,?\s+(?:send|post|curl|fetch|upload)/i, label: "exfiltration preamble" },
];

// `.env` must not be preceded by an identifier or `)` — otherwise `import.meta.env`
// and `process.env` (API identifiers, not credential files) match.
const CREDENTIAL_PATHS =
  /(?:~\/\.ssh\b|id_rsa\b|id_ed25519\b|\.aws\/credentials|\.netrc\b|\.npmrc\b|(?:ANTHROPIC|OPENAI|AWS_SECRET|GITHUB)_(?:API_)?(?:KEY|TOKEN|ACCESS_KEY)|(?<![\w).])\.env\b)/;

const URL_RE = /https?:\/\/[^\s)"'`<>\]]+/g;

const checks: Check[] = [
  {
    id: "injection-phrase",
    run(skill, file, content, findings) {
      for (const { re, label } of INJECTION_PHRASES) {
        const m = re.exec(content);
        if (m) {
          findings.push({
            skill: skill.dirName,
            file,
            line: lineOf(content, m.index),
            check: "injection-phrase",
            level: "flag",
            message: `${label}: known prompt-injection phrase`,
            evidence: snip(m[0]),
          });
        }
      }
    },
  },
  {
    id: "hidden-unicode",
    run(skill, file, content, findings) {
      // Invisible-character classes usable to smuggle instructions past a human
      // reader while the model still reads them. Tag characters (U+E0000 block)
      // can encode an entire ASCII message that renders as nothing at all.
      const classes: { re: RegExp; label: string }[] = [
        { re: /[​-‏‪-‮⁠-⁤﻿]/gu, label: "zero-width/bidi" },
        { re: /[\u{E0000}-\u{E007F}]/gu, label: "unicode tag" },
        { re: /[︀-️\u{E0100}-\u{E01EF}]/gu, label: "variation selector" },
      ];
      for (const { re, label } of classes) {
        const matches = [...content.matchAll(re)];
        if (matches.length === 0) continue;
        const codepoints = [
          ...new Set(
            matches.map((m) => "U+" + m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"))
          ),
        ].slice(0, 8);
        // Tag characters carry a decodable ASCII payload — decode and show it.
        let decoded = "";
        if (label === "unicode tag") {
          const text = matches
            .map((m) => {
              const cp = m[0].codePointAt(0)!;
              return cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : "";
            })
            .join("");
          if (text.trim()) decoded = ` -> decodes to: ${snip(text, 80)}`;
        }
        findings.push({
          skill: skill.dirName,
          file,
          line: lineOf(content, matches[0].index!),
          check: "hidden-unicode",
          level: "flag",
          message: `${matches.length} ${label} character(s) - invisible in rendered text`,
          evidence: codepoints.join(" ") + decoded,
        });
      }
    },
  },
  {
    id: "base64-payload",
    run(skill, file, content, findings) {
      const re = /[A-Za-z0-9+/]{40,}={0,2}/g;
      for (const m of content.matchAll(re)) {
        let decoded: string;
        try {
          decoded = Buffer.from(m[0], "base64").toString("utf8");
        } catch {
          continue;
        }
        const printable = decoded.replace(/[^\x20-\x7E\n\t]/g, "");
        if (printable.length / decoded.length < 0.9) continue;
        if (/https?:\/\/|curl\s|wget\s|\beval\b|\bexec\b|\/bin\/|sh\s+-c/i.test(printable)) {
          findings.push({
            skill: skill.dirName,
            file,
            line: lineOf(content, m.index!),
            check: "base64-payload",
            level: "flag",
            message: "base64 blob decodes to URL/command content",
            evidence: `decodes to: ${snip(printable, 80)}`,
          });
        }
      }
    },
  },
  {
    id: "pipe-to-shell",
    run(skill, file, content, findings) {
      const re = /\b(?:curl|wget)\b[^|\n]{0,200}\|\s*(?:ba|z|da)?sh\b/g;
      for (const m of content.matchAll(re)) {
        const comment = onCommentLine(content, m.index!);
        findings.push({
          skill: skill.dirName,
          file,
          line: lineOf(content, m.index!),
          check: "pipe-to-shell",
          level: "flag",
          message: `pipe-to-shell pattern${comment ? " (on a comment line)" : ""}`,
          evidence: snip(m[0]),
        });
      }
    },
  },
  {
    id: "destructive-path",
    run(skill, file, content, findings) {
      const re = /rm\s+-[a-z]*rf?[a-z]*\s+(?:\/(?:\s|$)|~\/?(?:\s|$)|"?\$HOME"?(?:\s|$))/g;
      for (const m of content.matchAll(re)) {
        const comment = onCommentLine(content, m.index!);
        findings.push({
          skill: skill.dirName,
          file,
          line: lineOf(content, m.index!),
          check: "destructive-path",
          level: "flag",
          message: `recursive-delete-of-root pattern${comment ? " (on a comment line)" : ""}`,
          evidence: snip(m[0]),
        });
      }
    },
  },
  {
    id: "credential-exfil",
    run(skill, file, content, findings) {
      if (!CREDENTIAL_PATHS.test(content)) return;
      // Flag only when a credential reference and an external URL share a line —
      // whole-file co-occurrence flags every doc that mentions .env and links anything.
      const lines = content.split("\n");
      let flagged = false;
      for (let i = 0; i < lines.length; i++) {
        const cred = CREDENTIAL_PATHS.exec(lines[i]);
        if (!cred) continue;
        const url = lines[i].match(URL_RE)?.find((u) => !/https?:\/\/(?:localhost|127\.0\.0\.1)/.test(u));
        if (url) {
          findings.push({
            skill: skill.dirName,
            file,
            line: i + 1,
            check: "credential-exfil",
            level: "flag",
            message: "credential reference and external URL on the same line",
            evidence: `${snip(cred[0], 40)} + ${snip(url, 60)}`,
          });
          flagged = true;
        }
      }
      if (!flagged) {
        const cred = CREDENTIAL_PATHS.exec(content)!;
        findings.push({
          skill: skill.dirName,
          file,
          line: lineOf(content, cred.index),
          check: "credential-ref",
          level: "info",
          message: "references a credential file or secret env var",
          evidence: snip(cred[0], 60),
        });
      }
    },
  },
  {
    id: "html-comment",
    run(skill, file, content, findings) {
      if (!file.endsWith(".md")) return;
      const re = /<!--([\s\S]*?)-->/g;
      for (const m of content.matchAll(re)) {
        const inner = m[1].trim();
        if (inner.length === 0) continue;
        const injected = INJECTION_PHRASES.some((p) => p.re.test(inner));
        findings.push({
          skill: skill.dirName,
          file,
          line: lineOf(content, m.index!),
          check: "html-comment",
          level: injected ? "flag" : "info",
          message: injected
            ? "HTML comment (hidden when rendered) contains an injection phrase"
            : "HTML comment — content hidden when markdown is rendered",
          evidence: snip(inner, 80),
        });
      }
    },
  },
  {
    id: "external-url",
    run(skill, file, content, findings) {
      const domains = new Set<string>();
      for (const m of content.matchAll(URL_RE)) {
        try {
          domains.add(new URL(m[0]).hostname);
        } catch {
          /* malformed URL — skip */
        }
      }
      domains.delete("localhost");
      domains.delete("127.0.0.1");
      if (domains.size > 0) {
        findings.push({
          skill: skill.dirName,
          file,
          check: "external-url",
          level: "info",
          message: `references ${domains.size} external domain(s)`,
          evidence: [...domains].sort().join(", "),
        });
      }
    },
  },
  {
    id: "shell-exec",
    run(skill, file, content, findings) {
      if (!/\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|rb)$/.test(file)) return;
      const re = /\b(?:eval\b|child_process|execSync|os\.system|subprocess\.(?:run|call|Popen))/g;
      const matches = [...content.matchAll(re)];
      if (matches.length === 0) return;
      findings.push({
        skill: skill.dirName,
        file,
        line: lineOf(content, matches[0].index!),
        check: "shell-exec",
        level: "info",
        message: `bundled script executes shell commands (${matches.length} site(s))`,
        evidence: snip(matches[0][0]),
      });
    },
  },
];

export function securityScan(skills: Skill[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [...frontmatterFindings(skills)];
  for (const skill of skills) {
    for (const file of skill.files) {
      if (file.content === undefined) {
        if (file.bytes > 0 && !/\.(?:png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(file.relPath)) {
          findings.push({
            skill: skill.dirName,
            file: file.relPath,
            check: "unscannable",
            level: "info",
            message: "binary or oversized file — not scanned",
            evidence: `${file.bytes} bytes`,
          });
        }
        continue;
      }
      for (const check of checks) check.run(skill, file.relPath, file.content, findings);
    }
  }

  // Skills that vendor a repo often carry near-identical per-harness copies of the
  // same file — collapse findings identical in everything but path into one line.
  const grouped = new Map<string, SecurityFinding & { count: number }>();
  for (const f of findings) {
    const key = [f.skill, f.check, f.level, f.message, f.evidence].join(" ");
    const existing = grouped.get(key);
    if (existing) existing.count++;
    else grouped.set(key, { ...f, count: 1 });
  }
  const deduped = [...grouped.values()].map((f) => {
    const { count, ...rest } = f;
    return count > 1 ? { ...rest, alsoInFiles: count - 1 } : rest;
  });

  const order = { flag: 0, info: 1 };
  return deduped.sort(
    (a, b) => order[a.level] - order[b.level] || a.skill.localeCompare(b.skill)
  );
}
