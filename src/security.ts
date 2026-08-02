import { join } from "node:path";
import type { Confidence, SecurityFinding, Severity, Skill } from "./types.js";
import { frontmatterFindings } from "./frontmatter.js";
import { isSkillMd, VENDOR_FILE_BUDGET } from "./skills.js";

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
  return colInQuotedSpan(content.slice(start, end), index - start);
}

/** The same test against a line already in hand, for line-oriented checks. */
function colInQuotedSpan(line: string, col: number): boolean {
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

function lineAt(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", start);
  if (end === -1) end = content.length;
  return content.slice(start, end);
}

/**
 * Comment syntax is per-language, and getting this wrong is worse than not
 * checking: in Markdown `#` is a heading and `*` is a list bullet — the two most
 * natural ways to write an instruction the model will follow. Treating those as
 * "commented out — inert" downgraded a live `curl | sh` to an info line.
 * In Markdown only an HTML comment is actually inert.
 */
/** Markdown in all the spellings the audited tools use — Cursor rules are `.mdc`. */
const MARKDOWN_FILE = /\.(?:md|mdc|markdown)$/i;

const COMMENT_SYNTAX: { re: RegExp; test: RegExp }[] = [
  { re: /\.(?:md|mdc|markdown|html?)$/i, test: /^\s*<!--/ },
  { re: /\.(?:sh|bash|zsh|fish|py|rb|pl|ya?ml|toml|cfg|conf|env)$/i, test: /^\s*#/ },
  { re: /\.(?:js|mjs|cjs|ts|tsx|jsx|json[c5]?|css|php|lua|r)$/i, test: /^\s*(?:\/\/|\/\*|\*)/ },
  { re: /\.(?:ini|lisp|el|clj)$/i, test: /^\s*;/ },
  { re: /\.(?:bat|cmd)$/i, test: /^\s*(?:rem\b|::)/i },
];

/** True when the match sits on a line that is a comment *in this file's language*. */
function onCommentLine(content: string, index: number, file: string): boolean {
  const line = lineAt(content, index);
  const syntax = COMMENT_SYNTAX.find((s) => s.re.test(file));
  // Unknown extension (bin/setup with no suffix): fall back to shell convention.
  return (syntax?.test ?? /^\s*#/).test(line);
}

/**
 * True when the token sits where a shell would execute it: line start, after a
 * pipe/separator/substitution, or after a markdown list marker (skills routinely
 * write commands as bullets). Prose like "if it fails, curl the health endpoint"
 * is not command position — that distinction is what keeps documentation from
 * flagging CRITICAL.
 */
function inCommandPosition(line: string, index: number): boolean {
  const before = line.slice(0, index);
  return /(?:^|[|;&]|\$\(|`|^\s*[-*+]\s|\b(?:sudo|env|then|do|else|exec|xargs|eval)\s+)\s*$/.test(before);
}

/**
 * True when the line actually hands a quoted string to an interpreter, rather
 * than merely containing an interpreter's name somewhere. The name alone is far
 * too cheap a signal: `https://bun.sh/install` contains a word-bounded `sh`
 * followed by a quote, which is enough to make an install script that only
 * *prints* its instructions look like one that runs them.
 */
function executesQuotedString(line: string): boolean {
  for (const m of line.matchAll(EXECUTES_A_QUOTED_STRING)) {
    if (inCommandPosition(line, m.index!)) return true;
  }
  return false;
}

/**
 * Characters that render as nothing (or as a break that reads as nothing) and so
 * can split a keyword invisibly. U+00AD SOFT HYPHEN belongs here and was the gap:
 * it is invisible in rendered markdown, survives NFKC, and split `cu<AD>rl` past
 * every check. The Hangul/Braille fillers are the same trick with a blank glyph.
 */
const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * What a variation selector is legitimately attached to: an emoji taking its
 * presentation form, or a keycap base (`1️⃣` is `1` + U+FE0F + U+20E3).
 */
const EMOJI_BASE = /[\p{Extended_Pictographic}0-9#*]/u;

/** The whole code point ending at `index`, surrogate pair included. */
function precedingCodePoint(s: string, index: number): string {
  if (index <= 0) return "";
  const unit = s.charCodeAt(index - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && index >= 2) return s.slice(index - 2, index);
  return s[index - 1];
}

/**
 * Cyrillic and Greek letters that render identically to ASCII. NFKC does NOT
 * fold these — it is a compatibility decomposition, so `сurl` with a Cyrillic
 * `с` survives it untouched and defeats every keyword check downstream.
 */
const HOMOGLYPHS: Record<string, string> = {
  а: "a", в: "b", с: "c", ԁ: "d", е: "e", ѕ: "s", һ: "h", і: "i", ј: "j", к: "k",
  ӏ: "l", м: "m", н: "h", о: "o", р: "p", ԛ: "q", г: "r", т: "t", и: "u", у: "y",
  х: "x", ѡ: "w", А: "A", В: "B", С: "C", Е: "E", Ѕ: "S", Н: "H", І: "I", Ј: "J",
  К: "K", М: "M", О: "O", Р: "P", Т: "T", У: "Y", Х: "X",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u",
  χ: "x", Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N",
  Ο: "O", Ρ: "P", Τ: "T", Χ: "X",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

/**
 * Strip invisible characters, fold homoglyphs, and NFKC-normalize before pattern
 * matching. The most effective documented evasion is splitting keywords with
 * zero-width characters (`e<ZWSP>val`), soft hyphens, or Cyrillic homoglyphs;
 * matching raw text misses every one of them. Newlines survive, so line numbers
 * stay valid, and every substitution here is 1:1 so column offsets do too.
 */
function normalize(content: string): string {
  // Fast path. Every transform below only affects characters above U+007F, and
  // most of what gets scanned — bundled JS especially — is pure ASCII. Checking
  // once is far cheaper than three passes plus an NFKC pass over megabytes that
  // cannot change. Behaviour is identical; only the work is skipped.
  if (!/[^\x00-\x7F]/.test(content)) return content;
  return content
    .replace(INVISIBLE, "")
    .replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c])
    .normalize("NFKC");
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
const INJECTION_PHRASES: {
  re: RegExp;
  label: string;
  severity: Severity;
  confidence: Confidence;
  /**
   * The phrase names no instruction noun, so a trailing `about <topic>` changes
   * what it means: "forget everything you know about Google SEO" scopes a
   * sentence to a subject, and it is how ordinary coaching copy is written.
   * Reported as a fact but not gated — with one carve-out, below: if the topic
   * IS the instructions, `about` is not scoping anything and the phrase is the
   * attack after all.
   */
  scopable?: boolean;
}[] = [
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
    // The override catalogue above keys on the noun ("previous instructions").
    // Attacking the object instead — "forget everything you were told" — uses no
    // such noun and walked straight through.
    re: /\b(?:forget|disregard|ignore)\s+(?:everything|all)\s+(?:you\s+(?:were\s+told|know|have\s+been\s+told|learned)|(?:the\s+)?(?:above|before|previously|prior))/i,
    label: "instruction override (object form)",
    severity: "critical",
    confidence: "likely",
    scopable: true,
  },
  {
    re: /\b(?:supersedes?|overrides?|replaces?|takes\s+precedence\s+over)\s+(?:all\s+|any\s+)?(?:your|the)\s+(?:previous\s+|prior\s+|existing\s+|default\s+)?(?:safety\s+|system\s+|security\s+)?(?:instructions?|guidelines?|rules?|directives?|policies|constraints?)/i,
    label: "authority-override claim",
    severity: "critical",
    confidence: "likely",
  },
  {
    re: /\b(?:your\s+)?(?:prior|previous|earlier)\s+(?:instructions?|directives?|rules?)\s+(?:no\s+longer\s+apply|are\s+(?:now\s+)?(?:void|obsolete|superseded|cancell?ed|revoked))/i,
    label: "instruction revocation",
    severity: "critical",
    confidence: "likely",
  },
  {
    // Softer concealment wording — real, but common enough in ordinary writing
    // that it is reported at lower confidence rather than as a certainty.
    re: /\bkeep\s+(?:this|it)\s+(?:between\s+us|to\s+yourself|secret|quiet)\b|\bno\s+need\s+to\s+(?:mention|tell|inform|report|surface)\b|\b(?:omit|exclude)\s+(?:this|it)\s+from\s+(?:your\s+)?(?:summary|response|output|report)|\bdo\s+not\s+(?:mention|include|log|report)\s+(?:this|it)\s+in\s+(?:your\s+)?(?:summary|response|output)/i,
    label: "soft concealment directive",
    severity: "high",
    confidence: "possible",
  },
  {
    // A heading that announces a fresh instruction block mid-document.
    re: /^#{1,6}\s*(?:new|updated|revised|override|additional)\s+(?:system\s+)?(?:instructions?|directives?|rules?)\s*:?\s*$/im,
    label: "instruction-reset heading",
    severity: "high",
    confidence: "possible",
  },
  {
    re: /before\s+doing\s+anything\s+else,?\s+(?:send|post|curl|fetch|upload|read)/i,
    label: "priority-hijack preamble",
    severity: "high",
    confidence: "possible",
  },
];

/**
 * Paths whose contents are worth stealing. Used alone → info; with egress → trifecta.
 *
 * The agent-CLI credentials matter most and were the gap: on a machine running
 * Claude Code, `~/.claude/.credentials.json` is a live OAuth token — a more
 * valuable and more available target than an SSH key, and the one an attacker
 * shipping a *skill* is closest to. Same for the sibling agents' auth files.
 */
const SENSITIVE_PATHS =
  /(?:~\/\.ssh(?:\/|\b)|id_rsa\b|id_ed25519\b|\.aws\/credentials|\.config\/gcloud|\.netrc\b|\.npmrc\b|\.docker\/config\.json|Library\/Keychains|Login\s?Data\b|(?:ANTHROPIC|OPENAI|AWS_SECRET|GITHUB|NPM|SLACK|HF|STRIPE_SECRET)_(?:API_)?(?:KEY|TOKEN|ACCESS_KEY)|CLAUDE_CODE_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|(?<![\w).])\.env\b|\.claude\/\.credentials\.json|(?<![\w.])\.claude\.json\b|\.claude\/settings\.local\.json|\.codex\/auth\.json|\.gemini\/oauth_creds\.json|\.config\/gh\/hosts\.yml|\.git-credentials\b|\.kube\/config\b|\.gnupg(?:\/|\b)|\.pypirc\b|\.pgpass\b|\.terraform\.d\/credentials|(?:key4|logins)\.(?:db|json)\b|(?:Chrome|Chromium|Edge|Brave)\/[^\s'"]*\/(?:Cookies|Login\s?Data)|\.config\/op\/|terraform\.tfstate\b|\.m2\/settings\.xml|\.gradle\/gradle\.properties)/;

/**
 * Constructs that actually read a file, as opposed to naming it in prose.
 * An assignment counts: `K=~/.ssh/id_rsa` captures the path for later use, and
 * routing the path through a variable was a one-line way to walk out of every
 * same-line and proximity check below.
 */
const CRED_READ =
  /\b(?:cat|head|tail|less|more|source|scp|rsync|base64|xxd|openssl|jq|grep|awk|sed|cp|tar|zip|readFile(?:Sync)?|read_file|open|Get-Content|load_dotenv)\b|<\s*["']?[~$/.]|\$\(|`[^`]*[~$/]|^\s*(?:export\s+|local\s+|declare\s+|set\s+-x\s+)?[A-Za-z_]\w*=/;

/**
 * Network egress verbs/sinks.
 *
 * Split into two groups on purpose. The first ends on a word boundary; the
 * second ends on whitespace, because a trailing `\b` after `dig\s` requires a
 * word character next and so failed to match `dig $(…)` — the exact shape DNS
 * exfil uses. Note `.get` is here alongside `.post`: a query string is the
 * canonical way to exfiltrate over HTTP, and matching only POST/PUT assumed the
 * attacker would pick the polite verb.
 */
const EGRESS =
  /\b(?:curl|wget|aria2c|nc|ncat|scp|rsync|sendmail|fetch\(|requests\.(?:get|post|put)|axios\.(?:get|post|put)|httpx\.(?:get|post)|sendBeacon|https?\.request|urlopen|Invoke-WebRequest|Invoke-RestMethod)\b|\b(?:git\s+push|aws\s+s3\s+cp|gsutil\s+cp|gcloud\s+storage\s+cp|rclone\s+(?:copy|sync|copyto)|az\s+storage\s+blob\s+upload|s3cmd\s+put|mc\s+cp|gh\s+(?:api|gist)|mail\s+-s|dig|nslookup)\s/i;

/**
 * Programs that execute whatever arrives on stdin. The original check hardcoded
 * `sh`/`bash`, so `curl … | python3` — the same attack in another language —
 * was not an attack as far as the scanner was concerned.
 */
const INTERPRETER_STAGE =
  /^\s*(?:(?:sudo|nohup|command|exec|time|stdbuf)\s+|env\s+(?:\w+=\S*\s+)*)*(?:\/(?:usr\/)?bin\/)?(?:(?:ba|z|da|k|a)?sh|python[\d.]*|perl|ruby|node|deno|bun|php|osascript|pwsh|powershell|source|\.)\b|^\s*xargs\s+(?:-\S+\s+)*(?:(?:ba|z)?sh|python[\d.]*|node)\b/;

/** Fetches bytes from the network. */
const FETCH = /\b(?:curl|wget|aria2c|Invoke-WebRequest|iwr)\b/i;

/**
 * Git plumbing that prints stored bytes to stdout. Not a network fetch, but the
 * same pipeline: `git cat-file -p <hash> | bash` runs content the scanner never
 * attributed to a fetch verb, because the fetch side was an enumeration of
 * downloaders. Staging a payload as a git object and retrieving it this way is
 * the documented pairing, so the retrieval step has to be visible on its own.
 */
const GIT_OBJECT_READ = /\bgit\s+(?:cat-file|show|archive|unpack-file)\b/;

/**
 * Turns opaque bytes back into a command. A pipeline that decodes and then pipes
 * into an interpreter is download-execute with an extra hop — `| rev | sh` and
 * `| tr 'A-Za-z' 'N-ZA-Mn-za-m' | sh` both ran clean past the literal patterns.
 */
const DECODER =
  /\b(?:base64\s+(?:-d|-D|--decode)|xxd\s+-r|openssl\s+enc[^\n|]*-d\b|uudecode|gunzip|zcat|gzip\s+-d|funzip|rev)\b|\btr\s+["'][^"']{3,}["']\s+["'][^"']{3,}["']/;

/** A markdown table row — pipes there are formatting, not shell pipelines. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * A shell being handed a quoted string to run. Quoting normally means the text
 * is data — printed, matched, documented — but `sh -c "…"` is how you execute
 * it, so this is what keeps "quoted" from becoming a blanket exemption.
 */
const EXECUTES_A_QUOTED_STRING =
  /\b(?:eval|(?:ba|z|da|k)?sh|python[\d.]*|node|perl|ruby|system|popen|exec|xargs|Invoke-Expression)\b[^\n]{0,20}["']/g;

/**
 * Physical lines joined on a trailing backslash, each tagged with the 1-based
 * line it starts on. A shell continuation before the pipe (`curl … \` / `| sh`)
 * split the payload across two lines, and every single-line regex here missed it.
 */
function logicalLines(content: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const raw = content.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const start = i + 1;
    let text = raw[i];
    let joins = 0;
    while (/\\[ \t]*\r?$/.test(text) && i + 1 < raw.length && joins++ < 20) {
      text = text.replace(/\\[ \t]*\r?$/, " ") + raw[++i].trim();
    }
    out.push({ text, line: start });
  }
  return out;
}

/** Endpoints recurring as exfiltration sinks in documented campaigns. */
const EXFIL_SINKS =
  /(?:webhook\.site|requestbin|pipedream\.net|\.ngrok(?:-free)?\.(?:io|app)|burpcollaborator\.net|\.burp\.[a-z0-9.]+|oastify\.com|interact\.sh|trycloudflare\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com|pastebin\.com\/raw|paste\.ee|transfer\.sh|0x0\.st|file\.io)/i;

/**
 * Agent-native persistence targets — the set generic scanners miss.
 *
 * The most valuable target here is not a shell rc file: it is the agent's own
 * global instruction file. Text appended to `~/.claude/CLAUDE.md` is injected
 * into every future session of every project, needs no execution, and survives
 * deleting the skill entirely. `.zshenv` matters for the same reason `.zshrc`
 * does but is sourced by non-interactive shells too.
 */
const PERSISTENCE_TARGETS =
  /(?:~\/\.(?:zshrc|zshenv|zprofile|zlogin|bashrc|profile|bash_profile|bash_login)|~\/\.config\/fish\/config\.fish|crontab\s+-|LaunchAgents\/|LaunchDaemons\/|launchctl\s+(?:load|bootstrap)|systemctl\s+enable|\/etc\/systemd\/system\/|\.claude\/settings\.json|\.claude\/(?:agents|hooks|commands|plugins)\/|(?:~|\$HOME)\/(?:\.claude\/)?(?:CLAUDE|AGENTS)\.md|~\/\.codex\/config\.toml|~\/\.gemini\/settings\.json|~\/\.cursor\/rules|\.cursorrules\b|\.mcp\.json|\.git\/hooks\/|\.envrc\b|\.vscode\/tasks\.json|\bSOUL\.md\b|\bHEARTBEAT\.md\b)/;

/**
 * Agent instruction files addressed relative to the project rather than to the
 * home directory. Writing here is genuinely ambiguous — plenty of legitimate
 * skills maintain a project's CLAUDE.md — so it is reported as a fact rather
 * than flagged, unlike the home-directory copies above which no ordinary skill
 * has business rewriting.
 */
const PROJECT_INSTRUCTION_FILES = /(?:^|[\s"'\/])(?:CLAUDE|AGENTS)\.md\b/;

/**
 * Persistence installed by running a command rather than by writing a file.
 * These need no redirect to count as a write — `git config --global alias.x
 * '!curl …|sh'` is a complete persistence mechanism on one line, and requiring
 * a `>` meant none of them registered.
 */
const PERSISTENCE_COMMANDS =
  /\bgit\s+config\s+(?:--global|--system)\s+(?:alias\.|core\.hooksPath)|\bcrontab\s+-|\blaunchctl\s+(?:load|bootstrap)|\bsystemctl\s+(?:--user\s+)?enable|\bdefaults\s+write\b|\bschtasks\s+\/create/;

const URL_RE = /https?:\/\/[^\s)"'`<>\]]+/g;

/** 172.16/12 was missing from the original set — an SSRF-docs false positive. */
function isPrivateV4(dotted: string): boolean {
  return /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(dotted);
}

/**
 * What a decoded blob has to look like to be worth reporting. Wider than a
 * shell-only list: an encoded Python stager (`import os; os.system(...)`) hit
 * none of curl/wget/eval/exec and decoded to nothing at all.
 */
/** Link text that is a filename rather than a domain. */
const FILE_EXT_TEXT =
  /\.(?:md|markdown|txt|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|json|ya?ml|toml|ini|cfg|conf|lock|log|png|jpe?g|gif|svg|pdf|zip|tar|gz|html?|css|xml|csv)$/i;

const PAYLOAD_SHAPE =
  /https?:\/\/|\b(?:curl|wget|eval|exec|chmod|nc|bash|sh)\s|\/bin\/|sh\s+-c|\bimport\s+(?:os|socket|subprocess|base64|requests)\b|\bos\.system\b|\bsubprocess\.|\brequire\s*\(|child_process|Invoke-(?:Expression|WebRequest)|\bFromBase64String\b|~\/\.(?:ssh|aws|config)/i;

const checks: Check[] = [
  {
    id: "injection-phrase",
    run(skill, file, content, findings) {
      for (const { re, label, severity, confidence, scopable } of INJECTION_PHRASES) {
        // Every occurrence, not just the first: a skill with ten injected
        // instructions should not read as having one.
        for (const m of content.matchAll(new RegExp(re.source, re.flags + "g"))) {
          const after = content.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
          // `about <topic>` scopes the sentence — unless the topic is the
          // instructions themselves, in which case nothing has been scoped and
          // "forget everything you know about your prior instructions" would
          // have bought a downgrade for the price of one word.
          const scoped =
            scopable === true &&
            /^\s+about\s+\S/i.test(after) &&
            !/^\s+about\s+[^.\n]{0,40}\b(?:instruction|rule|guideline|prompt|directive|polic|constraint|system|safety|security|restriction)/i.test(
              after
            );
          push(findings, skill, file, {
            // Reported, never gated: a phrase this common in ordinary writing
            // must not hard-stop an install, but deleting the fact would make
            // the audit lie by omission.
            line: lineOf(content, m.index!),
            check: "injection-phrase",
            level: scoped ? "info" : "flag",
            severity: scoped ? "low" : severity,
            confidence: scoped ? "possible" : confidence,
            message: scoped
              ? `${label}: matches a known injection pattern but is scoped to a topic ("… about …") — ordinary prose reads this way`
              : `${label}: known prompt-injection pattern`,
            evidence: snip(scoped ? lineAt(content, m.index!) : m[0]),
          });
        }
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
      const emit = (line: number, text: string, label: string, evidence: string): void => {
        const comment = (COMMENT_SYNTAX.find((s) => s.re.test(file))?.test ?? /^\s*#/).test(text);
        // A commented-out command does not execute — report it, but don't fail on it.
        push(findings, skill, file, {
          line,
          check: "download-execute",
          level: comment ? "info" : "flag",
          severity: comment ? "low" : "critical",
          confidence: comment ? "possible" : "likely",
          message: `${label}${comment ? " (commented out — inert)" : ""}`,
          evidence: snip(evidence),
        });
      };

      // Pipeline model. Enumerating `| sh` and `| bash` literally meant every
      // other terminal stage was a free bypass: `| python3`, `| sudo bash`,
      // `| tee /tmp/x | sh`, and a decode hop in the middle all ran clean.
      // What matters is only that bytes arrive from the network (or come out of
      // a decoder) and the pipeline ends in something that executes them.
      for (const { text, line } of logicalLines(content)) {
        if (TABLE_ROW.test(text)) continue;
        const stages = text.split("|");
        if (stages.length < 2) continue;
        if (!INTERPRETER_STAGE.test(stages[stages.length - 1])) continue;
        const upstream = stages.slice(0, -1).join("|");
        if (FETCH.test(upstream)) {
          emit(line, text, "download piped to an interpreter", text.trim());
        } else if (DECODER.test(upstream)) {
          emit(line, text, "decoded content piped to an interpreter", text.trim());
        } else if (GIT_OBJECT_READ.test(upstream)) {
          emit(line, text, "git object contents piped to an interpreter", text.trim());
        }
      }

      const patterns: { re: RegExp; label: string }[] = [
        // Command substitution and process substitution: the download never
        // touches a pipe, so the pipeline model above cannot see it.
        {
          re: /\b(?:eval|(?:ba|z|da)?sh\s+-c|python[\d.]*\s+-c|node\s+-e|perl\s+-e)\s+["']?[$`]\(?\s*(?:curl|wget|git\s+(?:cat-file|show|archive))[^\n]{0,200}/g,
          label: "interpreter executing the output of a download",
        },
        {
          // `.` is the POSIX spelling of `source` and needs its own alternative:
          // `\b` never matches between a space and a dot, so folding it into the
          // word list below silently disabled it.
          re: /(?:\b(?:(?:ba|z|da|k)?sh|python[\d.]*|node|perl|ruby|source)|(?:^|[\s;&|])\.)\s+<\(\s*(?:curl|wget|git\s+(?:cat-file|show|archive))[^)\n]{0,200}\)/g,
          label: "interpreter executing a process substitution of a download",
        },
        { re: /eval\s+\$\(\s*echo[^)]{0,200}base64[^)]{0,40}\)/g, label: "eval of base64-decoded content" },
        { re: /powershell[^\n]{0,80}-e(?:nc|ncodedcommand)\b/gi, label: "powershell encoded command" },
        {
          re: /\bIEX\s*\(\s*(?:New-Object\s+Net\.WebClient|iwr|Invoke-WebRequest)[^\n]{0,120}/gi,
          label: "powershell download executed inline",
        },
      ];
      for (const { re, label } of patterns) {
        for (const m of content.matchAll(re)) {
          emit(lineOf(content, m.index!), lineAt(content, m.index!), label, m[0]);
        }
      }
    },
  },
  {
    id: "staged-download-execute",
    run(skill, file, content, findings) {
      // Two-step download-then-run. This is the plainest way to fetch and execute
      // remote code and it matched none of the pipe-shaped patterns above, so the
      // most obvious attack in the class was also the cheapest bypass.
      const lines = logicalLines(content);
      const WINDOW = 8;
      const grab = [
        /\b(?:curl|wget|aria2c)\b[^\n]{0,200}?\s(?:-o|-O|--output(?:-document)?)[= ]\s*["']?([^\s"';|&]+)/,
        /\b(?:curl|wget|aria2c)\b[^\n|]{0,200}?>\s*["']?([^\s"';|&]+)/,
        /\bgit\s+clone\b[^\n]{0,200}?\s(?:https?|git|ssh):\/\/\S+\s+["']?([^\s"';|&]+)/,
      ];
      for (let i = 0; i < lines.length; i++) {
        let target: string | undefined;
        let rest = "";
        let restOffset = 0;
        let fetchCol = 0;
        for (const re of grab) {
          const m = re.exec(lines[i].text);
          if (m?.[1] && !/^-/.test(m[1])) {
            target = m[1];
            fetchCol = m.index;
            // `git clone <url> <dir> && <dir>/install.sh` puts fetch and execute
            // on one line, so the tail of this line is a candidate too.
            restOffset = m.index + m[0].length;
            rest = lines[i].text.slice(restOffset);
            break;
          }
        }
        // `-o /dev/null` and `> /dev/null` are discards, not staging.
        if (!target || /^\/dev\//.test(target)) continue;
        const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // The staged path being made executable, handed to an interpreter, or
        // invoked directly — all three are "and now run it".
        const runs = new RegExp(
          `chmod\\s+[^\\n]{0,20}\\+x[^\\n]{0,40}${esc}` +
            `|\\b(?:(?:ba|z|da|k)?sh|python[\\d.]*|node|perl|ruby|source|\\.)\\s+["']?${esc}` +
            `|(?:^|[|;&]|\\$\\(|\`|^\\s*[-*+]\\s)\\s*["']?\\.?/?${esc}(?:/[^\\s"';|&]*)?(?:\\s|["';|&]|$)`
        );
        for (let j = i; j < Math.min(lines.length, i + WINDOW); j++) {
          const text = j === i ? rest : lines[j].text;
          const run = runs.exec(text);
          if (!run) continue;
          // An install script that PRINTS the commands it wants a human to run
          // — `echo '  curl … -o "$tmpfile"' >&2` … `echo '  bash "$tmpfile"' >&2`
          // — matches this shape exactly while downloading and executing
          // nothing. Reporting "downloads to $tmpfile, then executes it on line
          // 13" about two `echo` lines is not a strict finding, it is a false
          // statement about the file, and it was the single least defensible
          // thing this tool said on a real machine. Quoting is also how a
          // command is passed to a shell, so only inert quoting counts: an
          // executor immediately before the quote still runs it.
          const runCol = (j === i ? restOffset : 0) + run.index;
          const inert =
            colInQuotedSpan(lines[i].text, fetchCol) &&
            !executesQuotedString(lines[i].text) &&
            colInQuotedSpan(lines[j].text, runCol) &&
            !executesQuotedString(lines[j].text);
          push(findings, skill, file, {
            line: lines[i].line,
            check: "staged-download-execute",
            level: inert ? "info" : "flag",
            severity: inert ? "low" : "critical",
            confidence: inert ? "possible" : "likely",
            message: inert
              ? `download-then-run sequence inside a quoted string — printed, not executed (target ${snip(target, 40)})`
              : j === i
                ? `downloads to ${snip(target, 40)} and executes it on the same line`
                : `downloads to ${snip(target, 40)}, then executes it on line ${lines[j].line}`,
            evidence: `${snip(lines[i].text, 50)}${j === i ? "" : ` … ${snip(lines[j].text, 50)}`}`,
          });
          i = j;
          break;
        }
      }
    },
  },
  {
    id: "remote-package-install",
    run(skill, file, content, findings) {
      // Installing from a URL or a git ref runs that package's install scripts.
      // The code is not in this skill, so nothing here can be audited.
      const re =
        /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\s+(?:-\S+\s+)*(https?:\/\/\S+|git\+\S+|github:\S+)|\bpip3?\s+install\s+(?:-\S+\s+)*(https?:\/\/\S+|git\+\S+)|\b(?:npx|bunx|pnpm\s+dlx)\s+(?:-\S+\s+)*(https?:\/\/\S+|github:\S+)/g;
      for (const m of content.matchAll(re)) {
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "remote-package-install",
          level: "flag",
          severity: "high",
          confidence: "possible",
          message: "installs a package from a URL/git ref rather than a registry — its install scripts are not in this package",
          evidence: snip(m[0], 90),
        });
      }
    },
  },
  {
    id: "reverse-shell",
    run(skill, file, content, findings) {
      // The `-e` flag does not have to sit directly after `nc`, the python import
      // list has no canonical order, and the mkfifo/openssl variants are what the
      // published cheat-sheets actually hand an attacker.
      const re =
        /socat[^\n]{0,80}exec:\s*\/bin\/(?:ba)?sh|\bnc(?:at)?\s[^\n]{0,60}?\s-[a-z]*e[a-z]*\s+["']?\/(?:usr\/)?bin\/|\/dev\/tcp\/\d|\bmkfifo\b[^\n]{0,140}\|\s*(?:nc|ncat|openssl|socat)\b|\bimport\s+socket\b[^\n]{0,60}\bsubprocess\b|\bsocket\.socket\([^\n]{0,100}\.connect\(|Runtime\.getRuntime\(\)\.exec/g;
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
        if (isPrivateV4(m[1])) continue;
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
      // Dotted-quad is only the readable spelling. Decimal, hex and IPv6 literals
      // resolve identically and evaded the check above entirely.
      const obfuscated =
        /https?:\/\/(?:(\d{8,10})|(0x[0-9a-fA-F]{6,8})|\[([0-9a-fA-F:]{4,})\])(?::\d+)?(?:\/\S*)?/g;
      for (const m of content.matchAll(obfuscated)) {
        if (m[1] || m[2]) {
          const n = m[1] ? Number(m[1]) : Number.parseInt(m[2], 16);
          if (n > 0xffffffff) continue; // not a valid packed IPv4
          // Decode and apply the same private-range exemption as the dotted form;
          // otherwise an SSRF test suite listing 169.254.169.254 flags as an attack.
          const dotted = [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join(".");
          if (isPrivateV4(dotted)) continue;
        }
        // Unique-local (fc00::/7), link-local (fe80::/10) and loopback IPv6.
        if (m[3] && /^(?:::1$|f[cd]|fe[89ab])/i.test(m[3])) continue;
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "raw-ip-url",
          level: "flag",
          severity: "high",
          confidence: "likely",
          message: "URL uses an obfuscated IP literal (decimal/hex/IPv6) instead of a hostname",
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
        const cmd = PERSISTENCE_COMMANDS.exec(lines[i]);
        if (cmd) {
          push(findings, skill, file, {
            line: i + 1,
            check: "persistence",
            level: "flag",
            severity: "high",
            confidence: "likely",
            message: "installs persistence via a command — survives removal of the skill",
            evidence: snip(lines[i], 100),
          });
          continue;
        }
        const m = PERSISTENCE_TARGETS.exec(lines[i]);
        if (!m) {
          // Project-level agent instruction files: report the write, do not fail
          // on it. Text landing here is injected into every future session in
          // this project, which is worth surfacing even though it is often legitimate.
          const proj = PROJECT_INSTRUCTION_FILES.exec(lines[i]);
          if (proj && /(?<![=\-<>|])>>?\s*["']?[~$/.\w]|\b(?:tee|sed\s+-i|cp|mv)\b/.test(lines[i])) {
            push(findings, skill, file, {
              line: i + 1,
              check: "agent-instruction-write",
              level: "info",
              severity: "medium",
              confidence: "possible",
              message: "writes to a project agent-instruction file — its text is injected into every future session in that project",
              evidence: snip(lines[i], 100),
            });
          }
          continue;
        }
        // Writing is the risk; merely naming the file is not. Require an actual
        // write mechanism — a redirect onto the target, or an in-place editor.
        // A bare `>` also appears in `=>`, `->` and JSX, so an arrow function in a
        // test name read as "writes to a startup file". Require a redirect shape.
        const REDIRECT = /(?<![=\-<>|])>>?\s*["']?[~$/.\w]/;
        // Copying or linking a file onto the target writes it just as surely as a
        // redirect does; `cp payload.sh ~/.claude/hooks/x.sh` is the whole attack.
        const writes =
          REDIRECT.test(lines[i].slice(0, m.index)) ||
          REDIRECT.test(lines[i]) ||
          /\b(?:tee|sed\s+-i|cp|mv|install|rsync|ln\s+-s|writeFile(?:Sync)?|Set-Content|Add-Content)\b|cat\s*>/.test(
            lines[i]
          );
        // A path inside quotes is often being printed or described rather than
        // written to (`echo "... .claude/settings.json ..."`). But quoting a
        // redirect target — `>> "$HOME/.claude/settings.json"` — is the normal
        // way to write it, so quoting alone must not suppress the finding.
        if (inQuotedSpan(lines[i], m.index) && !writes) continue;
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
          confidence: onCommentLine(content, m.index, file) ? "possible" : "likely",
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
        let matches = [...raw.matchAll(re)];
        // A variation selector attached to an emoji is that emoji's presentation
        // form — 🏗️ is U+1F3D7 U+FE0F — not steganography. Counting them
        // file-wide meant any document with three emoji flagged HIGH/likely,
        // which on a real machine was four of twenty-one flags and taught the
        // reader that "high" means "emoji". A DETACHED run is still the payload
        // shape and still flags.
        if (label === "variation selector") {
          matches = matches.filter((m) => !EMOJI_BASE.test(precedingCodePoint(raw, m.index!)));
        }
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
      // Candidates: single-token blobs, and multi-line blobs re-joined. `base64`
      // wraps at 76 columns by default, so requiring one unbroken token missed
      // the output of the very tool an attacker would use.
      const candidates: { text: string; index: number }[] = [];
      for (const m of content.matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)) {
        candidates.push({ text: m[0], index: m.index! });
      }
      // Leading whitespace is allowed: an indented (markdown code-block) blob is
      // the same payload, and anchoring at column 0 made four spaces a bypass.
      for (const m of content.matchAll(/(?:^[ \t]*[A-Za-z0-9+/_-]{20,}={0,2}\r?\n){2,}/gm)) {
        candidates.push({ text: m[0].replace(/\s+/g, ""), index: m.index! });
      }
      for (const { text, index } of candidates) {
        const before = content.slice(Math.max(0, index - 40), index);
        // Integrity hashes are legitimately base64 and decode to binary noise.
        if (/\b(?:sha\d{3}|integrity|checksum|digest)\b[^\n]{0,20}$/i.test(before)) continue;
        // An inline sourcemap is a base64 JSON blob full of file paths and URLs,
        // so it matches the payload shape every time. It is emitted by every
        // bundler on earth and says nothing about the file.
        if (/sourceMappingURL=data:[^,]*,$/i.test(before)) continue;
        // Accept base64url too — swapping the alphabet is a free evasion.
        const decoded = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
          "utf8"
        );
        if (!decoded) continue;
        const printable = decoded.replace(/[^\x20-\x7E\n\t]/g, "");
        if (printable.length / decoded.length < 0.9) continue;
        if (!PAYLOAD_SHAPE.test(printable)) continue;
        push(findings, skill, file, {
          line: lineOf(content, index),
          check: "base64-payload",
          level: "flag",
          severity: "critical",
          confidence: "certain",
          message: "base64 blob decodes to URL/command content",
          evidence: `decodes to: ${snip(printable, 80)}`,
        });
      }
    },
  },
  {
    id: "hex-payload",
    run(skill, file, content, findings) {
      // Same trick as base64 with a different alphabet — `xxd -r -p | sh`.
      for (const m of content.matchAll(/(?:[0-9a-fA-F]{2}){20,}/g)) {
        const before = content.slice(Math.max(0, m.index! - 40), m.index!);
        if (/\b(?:sha\d*|md5|hash|commit|checksum|digest|key|id)\b[^\n]{0,20}$/i.test(before)) continue;
        const decoded = Buffer.from(m[0], "hex").toString("utf8");
        const printable = decoded.replace(/[^\x20-\x7E\n\t]/g, "");
        if (printable.length / decoded.length < 0.9) continue;
        if (!PAYLOAD_SHAPE.test(printable)) continue;
        push(findings, skill, file, {
          line: lineOf(content, m.index!),
          check: "hex-payload",
          level: "flag",
          severity: "critical",
          confidence: "certain",
          message: "hex blob decodes to URL/command content",
          evidence: `decodes to: ${snip(printable, 80)}`,
        });
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
      // The target may be followed by a closing quote (`sh -c "rm -rf ~"`), not
      // only whitespace or end of line.
      const re = /rm\s+-[a-z]*rf?[a-z]*\s+(?:\/(?=[\s"']|$)|~\/?(?=[\s"']|$)|"?\$HOME"?(?=[\s"']|$))/g;
      for (const m of content.matchAll(re)) {
        const comment = onCommentLine(content, m.index!, file);
        // A match inside a quoted string is usually a search pattern or a message
        // — the shape of a safety tool documenting what it guards against. But
        // quoting is also how you pass a command to a shell, so `sh -c "rm -rf ~"`
        // must still flag; only inert quoting is skipped.
        const line = lineAt(content, m.index!);
        const executed = /\b(?:eval|sh|bash|zsh|system|popen|exec|Invoke-Expression)\b[^\n]{0,20}["']/.test(
          line
        );
        if (inQuotedSpan(content, m.index!) && !executed) continue;
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
        // Co-occurrence alone is not exfiltration: "if deploy fails, curl the
        // health endpoint and check .env is present" is documentation, and
        // flagging it CRITICAL is how a CI-gating scanner trains people to
        // ignore it. Require the send verb to actually be in command position.
        const send = EGRESS.exec(lines[i]);
        const egress = send !== null && inCommandPosition(lines[i], send.index);
        push(findings, skill, file, {
          line: i + 1,
          check: egress ? "credential-exfil" : "sensitive-path",
          level: egress ? "flag" : "info",
          severity: egress ? "critical" : "low",
          confidence: egress ? "likely" : "possible",
          message: egress
            ? "credential path passed to a network command on the same line"
            : send
              ? "credential path mentioned near a network verb (verb not in command position)"
              : "references a credential or secret path",
          evidence: snip(lines[i], 100),
        });
      }
    },
  },
  {
    id: "proximity-trifecta",
    run(skill, file, content, findings) {
      // credential-exfil needs both halves on one line; split-trifecta needs them
      // in different files. Two adjacent lines in one file fell between the two.
      const lines = content.split("\n");
      const WINDOW = 6;
      for (let i = 0; i < lines.length; i++) {
        if (!SENSITIVE_PATHS.test(lines[i])) continue;
        if (EGRESS.test(lines[i])) continue; // already credential-exfil's territory
        // Merely naming a credential path near a curl is documentation — a deploy
        // guide saying "load config from .env" two steps above a curl example is
        // the common shape. Require the path to actually be read.
        if (!CRED_READ.test(lines[i])) continue;
        for (let j = i + 1; j < Math.min(lines.length, i + WINDOW); j++) {
          const send = EGRESS.exec(lines[j]) ?? EXFIL_SINKS.exec(lines[j]);
          if (!send || !inCommandPosition(lines[j], send.index)) continue;
          push(findings, skill, file, {
            line: i + 1,
            check: "proximity-trifecta",
            level: "flag",
            severity: "critical",
            confidence: "likely",
            message: `reads a credential path, then sends on line ${j + 1} — ${j - i} line(s) apart`,
            evidence: `${snip(lines[i], 50)} … ${snip(lines[j], 50)}`,
          });
          i = j; // one finding per read/send pairing
          break;
        }
      }
    },
  },
  {
    id: "html-comment",
    run(skill, file, content, findings) {
      if (!MARKDOWN_FILE.test(file)) return;
      const re = /<!--([\s\S]*?)-->/g;
      for (const m of content.matchAll(re)) {
        const inner = m[1].trim();
        if (inner.length === 0) continue;
        const injected = INJECTION_PHRASES.some((p) => p.re.test(inner));
        // No length cap: padding the comment past 500 chars used to downgrade a
        // hidden command to an info line, which is a free evasion.
        const cmd = /\b(?:curl|wget|eval|exec|base64|nc)[ \t]/.test(inner);
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
      if (!MARKDOWN_FILE.test(file)) return;
      // Link text is usually a bare domain, not a full URL — `[docs.anthropic.com]
      // (https://evil.example)` is the actual phishing shape and requiring a
      // scheme in the text missed it.
      const re = /\[((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}[^\]\s]*)\]\((https?:\/\/[^)\s]+)\)/gi;
      for (const m of content.matchAll(re)) {
        // `[setup.sh](...)` and `[README.md](...)` are filenames, not hostnames.
        if (FILE_EXT_TEXT.test(m[1])) continue;
        try {
          const shown = new URL(/^https?:\/\//i.test(m[1]) ? m[1] : `https://${m[1]}`).hostname;
          const actual = new URL(m[2]).hostname;
          // Compare registrable domain: `[docs.example.com](https://example.com)`
          // is ordinary shorthand, not a mismatch worth reporting.
          const reg = (h: string): string => h.split(".").slice(-2).join(".");
          if (reg(shown) !== reg(actual)) {
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
      if (!MARKDOWN_FILE.test(file)) return;
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
    id: "install-time-execution",
    run(skill, file, content, findings) {
      // `setup.py` runs top to bottom on `pip install .`, before any model is
      // involved. A network call or exec at module level is therefore install-time
      // code execution — the python half of the postinstall trick below.
      if (!/(?:^|\/)setup\.py$/.test(file)) return;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^\s/.test(lines[i]) || /^\s*#/.test(lines[i])) continue; // indented = inside a def
        const m = EGRESS.exec(lines[i]) ?? /\b(?:os\.system|subprocess\.(?:run|call|Popen)|eval|exec)\s*\(/.exec(lines[i]);
        if (!m) continue;
        push(findings, skill, file, {
          line: i + 1,
          check: "install-time-execution",
          level: "flag",
          severity: "critical",
          confidence: "likely",
          message: "setup.py runs a network call or subprocess at module level — this executes on install, before any model sees the package",
          evidence: snip(lines[i], 100),
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
  // Same standard as proximity-trifecta: a file that *names* a credential path or
  // happens to contain the word "curl" is not a reader or a sender. Two CSV data
  // files mentioning both is not a split attack.
  // The 1-based line each side is on, so the finding can cite one. Shipping
  // `line: null` on the one check whose whole message is "look at these two
  // files" left the reader nothing to open.
  const readers = texts
    .map((t) => ({
      ...t,
      line: t.text.split("\n").findIndex((l) => SENSITIVE_PATHS.test(l) && CRED_READ.test(l)) + 1,
    }))
    .filter((t) => t.line > 0);
  const senders = texts
    .map((t) => ({
      ...t,
      line:
        t.text.split("\n").findIndex((l) => {
          const send = EGRESS.exec(l) ?? EXFIL_SINKS.exec(l);
          return send !== null && inCommandPosition(l, send.index);
        }) + 1,
    }))
    .filter((t) => t.line > 0);
  // Report whenever some reader file differs from some sender file. The old test
  // asked whether *any* file did both and suppressed everything if so, so adding
  // one decoy file mentioning both disabled the check for the whole package.
  const pair = readers
    .flatMap((r) => senders.map((s) => ({ r, s })))
    .find(({ r, s }) => r.path !== s.path);
  if (pair) {
    push(findings, skill, pair.r.path, {
      line: pair.r.line,
      check: "split-trifecta",
      level: "flag",
      severity: "high",
      confidence: "possible",
      message: `credential access and network egress live in different files of this skill — sends from ${pair.s.path}:${pair.s.line}`,
      evidence: `reads: ${pair.r.path}:${pair.r.line} · sends: ${pair.s.path}:${pair.s.line}`,
    });
  }

  // npm lifecycle scripts run on `npm install`, with no model in the loop and no
  // permission prompt — the SKILL.md can say nothing but "run npm install". No
  // check read package.json at all, so this whole channel was unexamined.
  const pkg = skill.files.find((f) => /(?:^|\/)package\.json$/.test(f.relPath) && f.content);
  if (pkg?.content) {
    try {
      const scripts = (JSON.parse(pkg.content) as { scripts?: Record<string, unknown> }).scripts ?? {};
      for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) {
        const cmd = scripts[name];
        if (typeof cmd !== "string" || !cmd.trim()) continue;
        // Compiling in place is ordinary; handing control to a bundled file or to
        // the network is the thing worth stopping on.
        const handsOff =
          /\b(?:node|python[\d.]*|ruby|perl|(?:ba|z)?sh|npx|bunx|pnpm\s+dlx)\s+["']?[.\/~]|^\s*["']?[.\/]|\b(?:curl|wget)\b/.test(
            cmd
          ) || EGRESS.test(cmd);
        push(findings, skill, pkg.relPath, {
          check: "install-time-execution",
          level: handsOff ? "flag" : "info",
          severity: handsOff ? "critical" : "medium",
          confidence: handsOff ? "likely" : "certain",
          message: handsOff
            ? `npm "${name}" script runs bundled or remote code on install — before any model sees this package`
            : `npm "${name}" lifecycle script runs on install, with no permission prompt`,
          evidence: snip(cmd, 90),
        });
      }
    } catch {
      /* malformed package.json — the unscannable/binary checks already report it */
    }
  }

  // Git's compressed object storage, reported as a fact rather than silently
  // stepped over. One line per skill, not one per object: a real checkout has
  // thousands, and the point is only that this much unreadable data is here.
  const gitObjects = skill.files.filter((f) => f.gitObject);
  if (gitObjects.length > 0) {
    push(findings, skill, ".git/objects", {
      check: "git-object-storage",
      level: "info",
      severity: "low",
      confidence: "certain",
      message: `${gitObjects.length} compressed git object file(s) — not readable as text, so not scanned`,
      evidence: `${Math.round(gitObjects.reduce((s, f) => s + f.bytes, 0) / 1024)}KB of git storage`,
    });
  }

  // Payload staged where scanners traditionally do not look.
  for (const f of skill.files) {
    // Git stores nothing but zlib streams under `objects/` (bar the `info/`
    // index files). A file there that reads as TEXT is therefore not git data
    // no matter how hash-shaped its name is — and a hash-shaped name was the
    // one thing that used to buy a payload a free pass out of the walk.
    if (
      /(?:^|\/)\.git\/objects\//.test(f.relPath) &&
      !/(?:^|\/)\.git\/objects\/info\//.test(f.relPath) &&
      f.content !== undefined
    ) {
      push(findings, skill, f.relPath, {
        check: "git-dir-payload",
        level: "flag",
        severity: "critical",
        confidence: "likely",
        message: "plaintext file staged in .git/objects/ — git stores only compressed objects there",
        evidence: `${f.bytes} bytes`,
      });
      continue;
    }
    // `hooks/` is no longer blanket-whitelisted: git ships only `*.sample` there,
    // so a live hook in a distributed skill package is a payload, not git data.
    // Git's own metadata: all-caps top-level files (HEAD, ORIG_HEAD, FETCH_HEAD,
    // MERGE_HEAD, COMMIT_EDITMSG …), the known lowercase ones, and bulk subtrees.
    // The subtree allowlist is no longer a blanket prefix. Allowing `objects/`
    // and `refs/` wholesale meant `.git/objects/payload.sh` read as ordinary git
    // data. Git's own files in those trees never carry a script or document
    // extension, so requiring that is enough to tell them apart.
    const GIT_SCRIPT_EXT =
      /\.(?:sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|ts|php|lua|ps1|bat|cmd|md|markdown|txt|json|ya?ml|toml|ini|cfg|conf|html?|command|applescript)$/i;
    const inGitSubtree = /(?:^|\/)\.git\/(?:refs|logs|objects|info|branches|modules|worktrees|rebase-[a-z]+)\//.test(
      f.relPath
    );
    if (
      /(?:^|\/)\.git\//.test(f.relPath) &&
      !/(?:^|\/)\.git\/(?:[A-Z][A-Z_]*$|config|description|index|packed-refs|shallow|commondir|gitdir|hooks\/[^/]*\.sample$)/.test(
        f.relPath
      ) &&
      !(inGitSubtree && !GIT_SCRIPT_EXT.test(f.relPath))
    ) {
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
  const skillMd = skill.files.find((f) => isSkillMd(f.relPath));
  // Git's own object storage is excluded: it is unreadable by nature and a
  // skill installed from a git clone legitimately ships megabytes of it, so
  // counting it here would fail every such skill on the cover/payload shape.
  // It is reported separately as `git-object-storage` instead of vanishing.
  const opaque = skill.files.filter(
    (f) =>
      f.content === undefined &&
      !f.gitObject &&
      !/\.(?:png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(f.relPath)
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

/**
 * Roots of genuine third-party packages inside vendored trees, keyed by skill.
 * A root is a directory under node_modules/vendor/site-packages that carries a
 * package manifest — that manifest is what distinguishes "a dependency someone
 * installed" from "a file someone hid in a directory with a familiar name".
 */
function vendorPackageRoots(skill: Skill): string[] {
  const roots: string[] = [];
  for (const f of skill.files) {
    const m =
      /^(.*(?:^|\/)(?:node_modules|vendor|site-packages)\/(?:@[^/]+\/)?[^/]+)\/(?:package\.json|__init__\.py|METADATA|RECORD)$/.exec(
        f.relPath
      );
    if (m) roots.push(m[1] + "/");
  }
  return roots;
}

function isVendoredPackage(
  skillName: string,
  file: string,
  roots: Map<string, string[]>
): boolean {
  return (roots.get(skillName) ?? []).some((r) => file.startsWith(r));
}

/**
 * Capability disclosures: true, useful, and decision-relevant when you are
 * deciding whether to install something — noise once you already have.
 *
 * `allowed-tools: Bash` really does pre-approve arbitrary shell with no prompt,
 * so `scan` (pre-install) should stop on it. But it is also the single most
 * common line in a legitimate skill: on a real 75-skill directory it fired 38
 * times and made up three quarters of all flags, so an audit that gates on it
 * exits 1 forever and teaches its user to ignore the exit code. Reported either
 * way; only the gating changes.
 */
const CAPABILITY_DISCLOSURE = new Set([
  "broad-tool-grant",
  "runner-laundering",
  "bundled-script-autorun",
]);

/**
 * Absolute path per (skill, relative file), so every finding can name the file
 * to open rather than a path fragment the reader has to reassemble from the
 * skill list. Synthetic file labels (`node_modules`, `.git/objects`) have no
 * real file behind them and fall back to the skill directory.
 */
function absolutePaths(skills: Skill[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const skill of skills) {
    for (const f of skill.files) paths.set(`${skill.dirName} ${f.relPath}`, f.absPath);
    paths.set(`${skill.dirName} `, skill.dir);
  }
  return paths;
}

export function securityScan(skills: Skill[], strict = true): SecurityFinding[] {
  const findings: SecurityFinding[] = [...frontmatterFindings(skills)];
  const packageRoots = new Map<string, string[]>();
  for (const skill of skills) packageRoots.set(skill.dirName, vendorPackageRoots(skill));
  for (const skill of skills) {
    // Third-party package contents: counted, not read. Reported once per skill
    // rather than once per file, so a vendoring skill produces one fact instead
    // of six thousand.
    const vendored = skill.files.filter((f) => f.vendorPackage);
    if (vendored.length > 0) {
      push(findings, skill, "node_modules", {
        check: "vendored-dependencies",
        level: "info",
        severity: "medium",
        confidence: "certain",
        message: `ships ${vendored.length} file(s) of third-party package code — not audited here; run \`npm audit\` (or equivalent) against it`,
        evidence: `${Math.round(vendored.reduce((s, f) => s + f.bytes, 0) / 1024)}KB across vendored packages`,
      });
    }

    for (const file of skill.files) {
      if (file.vendorPackage) continue;
      if (file.skippedDir) {
        push(findings, skill, file.relPath, {
          check: "oversized-vendor-tree",
          level: "info",
          severity: "medium",
          confidence: "certain",
          message: `vendored dependency tree exceeds ${VENDOR_FILE_BUDGET} files — its contents are scanned, but this skill ships a large amount of third-party code`,
          evidence: file.relPath,
        });
        continue;
      }
      if (file.content === undefined) {
        // Git objects are aggregated into one fact by skillLevelChecks; a
        // checkout would otherwise emit thousands of identical "binary file"
        // lines and bury everything that matters.
        if (
          file.bytes > 0 &&
          !file.gitObject &&
          !/\.(?:png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(file.relPath)
        ) {
          push(findings, skill, file.relPath, {
            check: "unscannable",
            level: "info",
            severity: "low",
            confidence: "certain",
            message: "binary file — not scanned",
            evidence: `${file.bytes} bytes`,
          });
        }
        continue;
      }
      if (file.truncated) {
        // Padding a script past the scan cap used to hide it completely; now the
        // unread tail is itself a reported fact.
        push(findings, skill, file.relPath, {
          check: "truncated-scan",
          level: "info",
          severity: "medium",
          confidence: "certain",
          message: `file exceeds the scan limit — ${file.bytes - file.content.length} byte(s) past the cap were not read`,
          evidence: `${file.bytes} bytes total`,
        });
      }
      const normalized = normalize(file.content);
      for (const check of checks) check.run(skill, file.relPath, normalized, findings, file.content);
    }
    skillLevelChecks(skill, findings);
  }

  // Findings inside a real third-party package are reported, never gating.
  //
  // Walking vendored trees is what makes a planted `node_modules/evil/run.sh`
  // visible at all, but scanning 6,000 files of somebody else's library also
  // surfaces its sourcemaps, emoji test fixtures and shell-completion docs —
  // thirty flags that say nothing about the skill. Failing CI on those is how a
  // gate teaches people to ignore it, and third-party dependency review is
  // `npm audit`'s job.
  //
  // The discriminator is a manifest, NOT the directory name. A published package
  // has a package.json (or dist-info/__init__.py) at its root; a payload dropped
  // into a directory called `node_modules` has none. Keying on the path alone
  // would have handed attackers the exemption for the price of one mkdir.
  const paths = absolutePaths(skills);
  const dirs = new Map(skills.map((s) => [s.dirName, s.dir]));
  const scoped = findings.map((f) => {
    const relaxed = !strict && f.level === "flag" && CAPABILITY_DISCLOSURE.has(f.check);
    const withPath = {
      ...f,
      path: paths.get(`${f.skill} ${f.file}`) ?? join(dirs.get(f.skill) ?? "", f.file),
    };
    const g = relaxed ? { ...withPath, level: "info" as const } : withPath;
    if (!isVendoredPackage(g.skill, g.file, packageRoots)) return g;
    return g.level === "flag" ? { ...g, level: "info" as const, vendored: true } : { ...g, vendored: true };
  });

  // Skills that vendor a repo often carry near-identical per-harness copies of the
  // same file — collapse findings identical in everything but path into one line.
  const grouped = new Map<string, SecurityFinding & { count: number }>();
  for (const f of scoped) {
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
