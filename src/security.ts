import type { Confidence, SecurityFinding, Severity, Skill } from "./types.js";
import { frontmatterFindings } from "./frontmatter.js";

const snip = (s: string, n = 100): string =>
  (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ").trim();

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** True when index falls inside a single- or double-quoted span on its own line. */
function inQuotedSpan(content: string, index: number): boolean {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", index);
  if (end === -1) end = content.length;
  const line = content.slice(start, end);
  const col = index - start;
  for (const q of ['"', "'"]) {
    let open = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== q) continue;
      if (open === -1) open = i;
      else {
        if (col > open && col < i) return true;
        open = -1;
      }
    }
  }
  return false;
}

/** True when the match sits on a line that is (lexically) a comment — reported as part of the fact. */
function onCommentLine(content: string, index: number): boolean {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", start);
  if (end === -1) end = content.length;
  return /^\s*(?:#|\/\/|\*|<!--|;)/.test(content.slice(start, end));
}

const INVISIBLE =
  /[​-‏‪-‮⁠-⁤﻿︀-️\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * Strip invisible characters and NFKC-normalize before pattern matching.
 * The most effective documented evasion is splitting keywords with zero-width
 * characters (`e<ZWSP>val`) or Cyrillic homoglyphs; matching raw text misses
 * every one of them. Newlines survive, so line numbers stay valid.
 */
function normalize(content: string): string {
  return content.replace(INVISIBLE, "").normalize("NFKC");
}

interface Check {
  id: string;
  /** Runs per file. `raw` is the untouched text; `content` is normalized. */
  run(skill: Skill, file: string, content: string, findings: SecurityFinding[], raw: string): void;
}

type Add = Omit<SecurityFinding, "skill" | "file">;

function push(findings: SecurityFinding[], skill: Skill, file: string, add: Add): void {
  findings.push({ skill: skill.dirName, file, ...add });
}

/**
 * Injection phrases. Broad instruction-override and system-impersonation patterns
 * follow the Agent Threat Rules project (ATR-2026-00120, MIT), an open ruleset with
 * published true-negative cases. The negative lookahead on system impersonation is
 * ATR's documented fix for markdown links like [system](path).
 */
const INJECTION_PHRASES: { re: RegExp; label: string; severity: Severity; confidence: Confidence }[] = [
  {
    re: /(?:you\s+(?:must|should|will|shall)\s+)?(?:ignore|disregard|override|forget|bypass|circumvent|supersede|set\s+aside|discard)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system|safety|initial)\s+\w*\s*(?:instructions?|rules?|guidelines?|prompts?|directives?)/i,
    label: "instruction override",
    severity: "critical",
    confidence: "likely",
  },
  {
    re: /you\s+are\s+(?:now\s+)?in\s+(?:developer|unrestricted|god|admin|root|DAN)\s+mode|security\s+warnings?\s+are\s+(?:test\s+)?artifacts?/i,
    label: "mode-jailbreak",
    severity: "critical",
    confidence: "likely",
  },
  {
    re: /(?:\[SYSTEM\]\s*:|<\|system\|>|<\|im_start\|>system|<<SYS>>|\[INST\])(?!\()/,
    label: "system-role impersonation",
    severity: "high",
    confidence: "likely",
  },
  {
    re: /do\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to|alert|notify|reveal\s+(?:this\s+)?to)\s+the\s+user|don'?t\s+(?:tell|inform|show|mention\s+(?:this\s+)?to)\s+the\s+user|without\s+(?:informing|telling|notifying|asking)\s+the\s+user|hide\s+this\s+from\s+the\s+user/i,
    label: "concealment directive",
    severity: "critical",
    confidence: "likely",
  },
  {
    re: /before\s+doing\s+anything\s+else,?\s+(?:send|post|curl|fetch|upload|read)/i,
    label: "priority-hijack preamble",
    severity: "high",
    confidence: "possible",
  },
];

/** Paths whose contents are worth stealing. Used alone → info; with egress → trifecta. */
const SENSITIVE_PATHS =
  /(?:~\/\.ssh(?:\/|\b)|id_rsa\b|id_ed25519\b|\.aws\/credentials|\.config\/gcloud|\.netrc\b|\.npmrc\b|\.docker\/config\.json|Library\/Keychains|Login\s?Data\b|(?:ANTHROPIC|OPENAI|AWS_SECRET|GITHUB)_(?:API_)?(?:KEY|TOKEN|ACCESS_KEY)|(?<![\w).])\.env\b)/;

/** Network egress verbs/sinks. */
const EGRESS = /\b(?:curl|wget|nc|ncat|scp|rsync|fetch\(|requests\.(?:post|put)|http\.request|Invoke-WebRequest|git\s+push)\b/i;

/** Endpoints recurring as exfiltration sinks in documented campaigns. */
const EXFIL_SINKS =
  /(?:webhook\.site|requestbin|pipedream\.net|\.ngrok(?:-free)?\.(?:io|app)|burpcollaborator\.net|\.burp\.[a-z0-9.]+|oastify\.com|interact\.sh|trycloudflare\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com|pastebin\.com\/raw|paste\.ee|transfer\.sh|0x0\.st|file\.io)/i;

/** Agent-native persistence targets — the set generic scanners miss. */
const PERSISTENCE_TARGETS =
  /(?:~\/\.(?:zshrc|bashrc|profile|bash_profile)|crontab\s+-|LaunchAgents\/|launchctl\s+load|systemctl\s+enable|\/etc\/systemd\/system\/|\.claude\/settings\.json|\.claude\/agents\/|\.mcp\.json|\bSOUL\.md\b|\bHEARTBEAT\.md\b)/;

const URL_RE = /https?:\/\/[^\s)"'`<>\]]+/g;

const checks: Check[] = [
  {
    id: "injection-phrase",
    run(skill, file, content, findings) {
      for (const { re, label, severity, confidence } of INJECTION_PHRASES) {
        const m = re.exec(content);
        if (!m) continue;
        push(findings, skill, file, {
          line: lineOf(content, m.index),
          check: "injection-phrase",
          level: "flag",
          severity,
          confidence,
          message: `${label}: known prompt-injection pattern`,
          evidence: snip(m[0]),
        });
      }
    },
  },
  {
    id: "dynamic-context-exec",
    run(skill, file, content, findings) {
      // Claude Code executes !`cmd` in a SKILL.md BEFORE the model reasons about
      // it, so model-level refusal never fires. No equivalent in ordinary docs.
      if (!/\.md$/.test(file)) return;
      // The harness fires !`cmd` only when `!` is at line start or after
      // whitespace — `KEY=!`x`` and a backtick-quoted `` `!` `` do NOT execute.
      // Matching the real rule avoids flagging docs that quote a literal `!`.
      const re = /(^|[ \t])!`([^`\n]{1,200})`/gm;
      for (const m of content.matchAll(re)) {
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "dynamic-context-exec",
          level: "flag",
          severity: "critical",
          confidence: "certain",
          message: "dynamic-context command runs before the model reasons about it",
          evidence: snip("!`" + m[2] + "`", 90),
        });
      }
    },
  },
  {
    id: "download-execute",
    run(skill, file, content, findings) {
      const patterns: { re: RegExp; label: string }[] = [
        { re: /\b(?:curl|wget)\b[^|\n]{0,200}\|\s*(?:ba|z|da)?sh\b/g, label: "download piped to shell" },
        { re: /\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)[^)]{0,200}\)/g, label: "shell -c executing a download" },
        { re: /\b(?:curl|wget)\b[^|\n]{0,200}\|\s*(?:source|\.)\s/g, label: "remote content sourced into the shell" },
        { re: /base64\s+(?:-d|-D|--decode)[^\n]{0,80}\|\s*(?:ba|z|da)?sh\b/g, label: "base64-decoded content piped to shell" },
        { re: /eval\s+\$\(\s*echo[^)]{0,200}base64[^)]{0,40}\)/g, label: "eval of base64-decoded content" },
        { re: /powershell[^\n]{0,80}-e(?:nc|ncodedcommand)\b/gi, label: "powershell encoded command" },
      ];
      for (const { re, label } of patterns) {
        for (const m of content.matchAll(re)) {
          const comment = onCommentLine(content, m.index!);
          // A commented-out command does not execute — report it, but don't fail on it.
          push(findings, skill, file, {
            line: lineOf(content, m.index!),
            check: "download-execute",
            level: comment ? "info" : "flag",
            severity: comment ? "low" : "critical",
            confidence: comment ? "possible" : "likely",
            message: `${label}${comment ? " (commented out — inert)" : ""}`,
            evidence: snip(m[0]),
          });
        }
      }
    },
  },
  {
    id: "reverse-shell",
    run(skill, file, content, findings) {
      const re =
        /socat[^\n]{0,80}exec:\s*\/bin\/(?:ba)?sh|\bnc\s+(?:-[a-z]*e[a-z]*)\s|\b(?:ba)?sh\s+-i\s*>&\s*\/dev\/tcp\/|import\s+socket\s*,\s*subprocess\s*,\s*os/g;
      for (const m of content.matchAll(re)) {
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "reverse-shell",
          level: "flag",
          severity: "critical",
          confidence: "likely",
          message: "reverse-shell pattern",
          evidence: snip(m[0]),
        });
      }
    },
  },
  {
    id: "password-protected-archive",
    run(skill, file, content, findings) {
      // Documented in every large campaign; legitimate skills essentially never
      // ship an archive the scanner cannot open.
      const re = /\b(?:unzip\s+-P\s*\S+|7z\s+x\s+-p\S+|--password[= ]\S+)/g;
      for (const m of content.matchAll(re)) {
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "password-protected-archive",
          level: "flag",
          severity: "critical",
          confidence: "likely",
          message: "extracts a password-protected archive — contents cannot be scanned",
          evidence: snip(m[0], 80),
        });
      }
    },
  },
  {
    id: "raw-ip-url",
    run(skill, file, content, findings) {
      const re = /https?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/\S*)?/g;
      for (const m of content.matchAll(re)) {
        if (/^(?:127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.)/.test(m[1])) continue;
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "raw-ip-url",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: "URL points at a raw public IP address rather than a hostname",
          evidence: snip(m[0], 80),
        });
      }
    },
  },
  {
    id: "exfil-sink",
    run(skill, file, content, findings) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const sink = EXFIL_SINKS.exec(lines[i]);
        if (!sink) continue;
        // A sink in prose is documentation; a sink beside a send verb is a pipe.
        const withVerb = EGRESS.test(lines[i]);
        push(findings, skill, file, {
          line: i + 1,
          check: "exfil-sink",
          level: withVerb ? "flag" : "info",
          severity: withVerb ? "critical" : "low",
          confidence: withVerb ? "likely" : "possible",
          message: withVerb
            ? "known exfiltration endpoint used with a send/upload command"
            : "references a known exfiltration endpoint (no send verb on this line)",
          evidence: snip(lines[i], 100),
        });
      }
    },
  },
  {
    id: "remote-instructions",
    run(skill, file, content, findings) {
      // A skill whose real instructions live on a server cannot be audited at all.
      const re = /\b(?:curl|wget)\b[^\n]{0,160}\.(?:md|txt|json)\b[^\n]{0,40}\|\s*(?:source|\.|(?:ba|z)?sh)\b/g;
      for (const m of content.matchAll(re)) {
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "remote-instructions",
          level: "flag",
          severity: "critical",
          confidence: "likely",
          message: "fetches instructions at runtime — actual behavior is not in this package",
          evidence: snip(m[0], 90),
        });
      }
    },
  },
  {
    id: "persistence",
    run(skill, file, content, findings) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = PERSISTENCE_TARGETS.exec(lines[i]);
        if (!m) continue;
        // A path inside quotes is being printed or described, not written to
        // (e.g. echo "... .claude/settings.json ..." status messages).
        if (inQuotedSpan(lines[i], m.index)) continue;
        // Writing is the risk; merely naming the file is not. Require an actual
        // write mechanism — a redirect onto the target, or an in-place editor.
        const writes = /(?:>>?|tee|sed\s+-i)\s*\S*$|>>?\s*["']?\S*(?:settings\.json|rc|profile|\.md|mcp\.json)/i.test(
          lines[i].slice(0, m.index)
        ) || /(?:>>|>|tee|sed\s+-i|cat\s*>)/.test(lines[i]);
        push(findings, skill, file, {
          line: i + 1,
          check: "persistence",
          level: writes ? "flag" : "info",
          severity: writes ? "high" : "low",
          confidence: writes ? "likely" : "possible",
          message: writes
            ? "writes to a startup/agent-config file — survives removal of the skill"
            : "references a startup/agent-config file",
          evidence: snip(lines[i], 100),
        });
      }
    },
  },
  {
    id: "permission-weakening",
    run(skill, file, content, findings) {
      const patterns: { re: RegExp; label: string }[] = [
        // Note: --no-sandbox is deliberately excluded — it is overwhelmingly a
        // Chromium/Playwright CI flag, not a Claude/Codex permission bypass.
        { re: /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo\b|--full-auto\b|danger-full-access|approval_policy\s*=\s*"never"/i, label: "permission-bypass flag" },
        { re: /permissionMode:\s*bypassPermissions|--permission-mode\s+bypassPermissions/i, label: "bypassPermissions mode" },
        { re: /--no-session-persistence\b/i, label: "session-persistence disabled (anti-audit)" },
      ];
      for (const { re, label } of patterns) {
        const m = re.exec(content);
        if (!m) continue;
        push(findings, skill, file, {
          line: lineOf(content, m.index),
          check: "permission-weakening",
          level: "flag",
          severity: "critical",
          confidence: onCommentLine(content, m.index) ? "possible" : "likely",
          message: `${label} — a skill asking to weaken agent safety controls`,
          evidence: snip(m[0], 90),
        });
      }
    },
  },
  {
    id: "silencing",
    run(skill, file, content, findings) {
      const re = /\bnohup\b[^\n]{0,80}&\s*$|>\s*\/dev\/null\s+2>&1|\bsilently\b|\bwithout\s+(?:any\s+)?output\b/gim;
      const matches = [...content.matchAll(re)];
      if (matches.length === 0) return;
      push(findings, skill, file, {
        line: lineOf(content, matches[0].index!),
        check: "silencing",
        level: "info",
        severity: "medium",
        confidence: "possible",
        message: `${matches.length} output-suppression pattern(s) — common in scripts, also used to hide activity`,
        evidence: snip(matches[0][0], 80),
      });
    },
  },
  {
    id: "hidden-unicode",
    run(skill, file, _content, findings, raw) {
      // Runs on RAW text — this check is about the characters normalization removes.
      // Thresholds follow published guidance: tag characters have no legitimate use
      // in skill files (flag one); zero-width and variation selectors occur in real
      // typography, so require a run of 3+.
      const classes: { re: RegExp; label: string; min: number; severity: Severity }[] = [
        { re: /[\u{E0000}-\u{E007F}]/gu, label: "unicode tag", min: 1, severity: "critical" },
        { re: /[‪-‮⁦-⁩]/gu, label: "bidi override", min: 1, severity: "high" },
        { re: /[​-‍⁠-⁤﻿]/gu, label: "zero-width", min: 3, severity: "high" },
        { re: /[︀-️\u{E0100}-\u{E01EF}]/gu, label: "variation selector", min: 3, severity: "high" },
      ];
      for (const { re, label, min, severity } of classes) {
        const matches = [...raw.matchAll(re)];
        if (matches.length < min) continue;
        const codepoints = [
          ...new Set(
            matches.map((m) => "U+" + m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"))
          ),
        ].slice(0, 8);
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
        push(findings, skill, file, {
          line: lineOf(raw, matches[0].index!),
          check: "hidden-unicode",
          level: "flag",
          severity,
          // A dense run is an encoded payload, not incidental typography.
          confidence: matches.length > 10 || label === "unicode tag" ? "certain" : "likely",
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
        const before = content.slice(Math.max(0, m.index! - 40), m.index!);
        // Integrity hashes are legitimately base64 and decode to binary noise.
        if (/\b(?:sha\d{3}|integrity|checksum|digest)\b[^\n]{0,20}$/i.test(before)) continue;
        let decoded: string;
        try {
          decoded = Buffer.from(m[0], "base64").toString("utf8");
        } catch {
          continue;
        }
        const printable = decoded.replace(/[^\x20-\x7E\n\t]/g, "");
        if (printable.length / decoded.length < 0.9) continue;
        if (/https?:\/\/|curl\s|wget\s|\beval\b|\bexec\b|\/bin\/|sh\s+-c/i.test(printable)) {
          push(findings, skill, file, {
            line: lineOf(content, m.index!),
            check: "base64-payload",
            level: "flag",
            severity: "critical",
            confidence: "certain",
            message: "base64 blob decodes to URL/command content",
            evidence: `decodes to: ${snip(printable, 80)}`,
          });
        }
      }
    },
  },
  {
    id: "assembled-command",
    run(skill, file, content, findings) {
      // Keyword assembly from fragments is a documented evasion of literal matching.
      const patterns: { re: RegExp; label: string }[] = [
        { re: /getattr\s*\(\s*\w+\s*,\s*["'][a-z]{1,6}["']\s*\+\s*["'][a-z]{1,6}["']/gi, label: "getattr built from concatenated strings" },
        { re: /=\s*["'](?:cu|wg|ev|ex|ba)[a-z]{0,3}["']\s*\+\s*["'][a-z]{1,4}["']/gi, label: "command name built from string fragments" },
        { re: /(?:chr\(\d{1,3}\)\s*\+\s*){3,}/gi, label: "string built from chr() sequence" },
      ];
      for (const { re, label } of patterns) {
        for (const m of content.matchAll(re)) {
          push(findings, skill, file, {
            line: lineOf(content, m.index!),
            check: "assembled-command",
            level: "flag",
            severity: "high",
            confidence: "likely",
            message: `${label} — evades literal pattern matching`,
            evidence: snip(m[0], 80),
          });
        }
      }
    },
  },
  {
    id: "destructive-path",
    run(skill, file, content, findings) {
      const re = /rm\s+-[a-z]*rf?[a-z]*\s+(?:\/(?:\s|$)|~\/?(?:\s|$)|"?\$HOME"?(?:\s|$))/g;
      for (const m of content.matchAll(re)) {
        const comment = onCommentLine(content, m.index!);
        // A match inside a quoted string is a search pattern or a message, not a
        // command — the shape of a safety tool documenting what it guards against.
        const quoted = inQuotedSpan(content, m.index!);
        if (quoted) continue;
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "destructive-path",
          level: comment ? "info" : "flag",
          severity: comment ? "low" : "high",
          confidence: comment ? "possible" : "likely",
          message: `recursive-delete-of-root pattern${comment ? " (commented out — inert)" : ""}`,
          evidence: snip(m[0]),
        });
      }
    },
  },
  {
    id: "sensitive-path",
    run(skill, file, content, findings) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const hit = SENSITIVE_PATHS.exec(lines[i]);
        if (!hit) continue;
        const egress = EGRESS.test(lines[i]);
        push(findings, skill, file, {
          line: i + 1,
          check: egress ? "credential-exfil" : "sensitive-path",
          level: egress ? "flag" : "info",
          severity: egress ? "critical" : "low",
          confidence: egress ? "likely" : "possible",
          message: egress
            ? "credential path on the same line as a network command"
            : "references a credential or secret path",
          evidence: snip(lines[i], 100),
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
        const cmd = inner.length <= 500 && /\b(?:curl|wget|eval|exec|base64|nc)[ \t]/.test(inner);
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "html-comment",
          level: injected || cmd ? "flag" : "info",
          severity: injected ? "critical" : cmd ? "high" : "low",
          confidence: injected ? "likely" : "possible",
          message: injected
            ? "HTML comment (hidden when rendered) contains an injection phrase"
            : cmd
              ? "HTML comment (hidden when rendered) contains a command verb"
              : "HTML comment — content hidden when markdown is rendered",
          evidence: snip(inner, 80),
        });
      }
    },
  },
  {
    id: "link-mismatch",
    run(skill, file, content, findings) {
      if (!file.endsWith(".md")) return;
      const re = /\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g;
      for (const m of content.matchAll(re)) {
        try {
          const shown = new URL(m[1]).hostname;
          const actual = new URL(m[2]).hostname;
          if (shown !== actual) {
            push(findings, skill, file, {
              line: lineOf(content, m.index!),
              check: "link-mismatch",
              level: "flag",
              severity: "medium",
              confidence: "certain",
              message: `link text shows ${shown} but points to ${actual}`,
              evidence: snip(m[0], 100),
            });
          }
        } catch {
          /* malformed URL — skip */
        }
      }
    },
  },
  {
    id: "interpolated-image",
    run(skill, file, content, findings) {
      if (!file.endsWith(".md")) return;
      // An image URL carrying interpolated data exfiltrates on render, no click.
      const re = /!\[[^\]]*\]\((https?:\/\/[^)]*(?:\$\{[^}]+\}|\{\{[^}]+\}\}|\$[A-Z_]{3,})[^)]*)\)/g;
      for (const m of content.matchAll(re)) {
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "interpolated-image",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: "image URL interpolates a variable — fetched on render, exfiltrates its value",
          evidence: snip(m[0], 90),
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
        push(findings, skill, file, {
          check: "external-url",
          level: "info",
          severity: "low",
          confidence: "certain",
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
      push(findings, skill, file, {
        line: lineOf(content, matches[0].index!),
        check: "shell-exec",
        level: "info",
        severity: "low",
        confidence: "certain",
        message: `bundled script executes shell commands (${matches.length} site(s))`,
        evidence: snip(matches[0][0]),
      });
    },
  },
];

/** Checks that need the whole package, not one file at a time. */
function skillLevelChecks(skill: Skill, findings: SecurityFinding[]): void {
  const texts = skill.files
    .filter((f) => f.content !== undefined)
    .map((f) => ({ path: f.relPath, text: normalize(f.content!) }));

  // Lethal trifecta split across files: read secrets in one file, send in another.
  const readers = texts.filter((t) => SENSITIVE_PATHS.test(t.text));
  const senders = texts.filter((t) => EGRESS.test(t.text) || EXFIL_SINKS.test(t.text));
  if (readers.length > 0 && senders.length > 0) {
    const sameFile = readers.some((r) => senders.some((s) => s.path === r.path));
    if (!sameFile) {
      push(findings, skill, readers[0].path, {
        check: "split-trifecta",
        level: "flag",
        severity: "high",
        confidence: "possible",
        message: "credential access and network egress live in different files of this skill",
        evidence: `reads: ${readers[0].path} · sends: ${senders[0].path}`,
      });
    }
  }

  // Payload staged where scanners traditionally do not look.
  for (const f of skill.files) {
    if (/(?:^|\/)\.git\//.test(f.relPath) && !/(?:^|\/)\.git\/(?:config|HEAD|description|index|COMMIT_EDITMSG|packed-refs|hooks\/|refs\/|logs\/|objects\/|info\/|branches\/)/.test(f.relPath)) {
      push(findings, skill, f.relPath, {
        check: "git-dir-payload",
        level: "flag",
        severity: "critical",
        confidence: "likely",
        message: "non-git file staged inside .git/ — a documented scanner blind spot",
        evidence: `${f.bytes} bytes`,
      });
    }
  }

  // A tiny SKILL.md shipping a large opaque payload is the cover/payload shape.
  const skillMd = skill.files.find((f) => f.relPath === "SKILL.md");
  const opaque = skill.files.filter(
    (f) => f.content === undefined && !/\.(?:png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(f.relPath)
  );
  const opaqueBytes = opaque.reduce((sum, f) => sum + f.bytes, 0);
  if (skillMd && skillMd.bytes < 2048 && opaqueBytes > 256 * 1024) {
    push(findings, skill, "SKILL.md", {
      check: "cover-asymmetry",
      level: "flag",
      severity: "medium",
      confidence: "possible",
      message: `small SKILL.md (${skillMd.bytes}B) ships ${Math.round(opaqueBytes / 1024)}KB of unscannable files`,
      evidence: opaque.slice(0, 3).map((f) => f.relPath).join(", "),
    });
  }
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const CONFIDENCE_ORDER: Record<Confidence, number> = { certain: 0, likely: 1, possible: 2 };

export function securityScan(skills: Skill[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [...frontmatterFindings(skills)];
  for (const skill of skills) {
    for (const file of skill.files) {
      if (file.content === undefined) {
        if (file.bytes > 0 && !/\.(?:png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(file.relPath)) {
          push(findings, skill, file.relPath, {
            check: "unscannable",
            level: "info",
            severity: "low",
            confidence: "certain",
            message: "binary or oversized file — not scanned",
            evidence: `${file.bytes} bytes`,
          });
        }
        continue;
      }
      const normalized = normalize(file.content);
      for (const check of checks) check.run(skill, file.relPath, normalized, findings, file.content);
    }
    skillLevelChecks(skill, findings);
  }

  // Skills that vendor a repo often carry near-identical per-harness copies of the
  // same file — collapse findings identical in everything but path into one line.
  const grouped = new Map<string, SecurityFinding & { count: number }>();
  for (const f of findings) {
    const key = [f.skill, f.check, f.level, f.message, f.evidence].join(" ");
    const existing = grouped.get(key);
    if (existing) existing.count++;
    else grouped.set(key, { ...f, count: 1 });
  }
  const deduped = [...grouped.values()].map((f) => {
    const { count, ...rest } = f;
    return count > 1 ? { ...rest, alsoInFiles: count - 1 } : rest;
  });

  return deduped.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      a.skill.localeCompare(b.skill)
  );
}
