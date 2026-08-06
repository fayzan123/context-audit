// Opt-in real-time capture for Claude Code: `hooks install` wires the
// harness's own hook events to `context-audit log-event`, which maps each
// payload to a ledger event. Install never writes without explicit confirm —
// the caller prints the diff and decides. log-event never throws: a broken
// hook must never break the user's session.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEDGER_SCHEMA_VERSION, NAME_RE } from "./ledger.js";
import type { Ledger } from "./ledger.js";
import type { AssetKind, LedgerEvent } from "./types.js";

/** The exact command each installed hook runs — also the uninstall match key. */
const hookCommand = (event: string): string => `context-audit log-event --claude-hook ${event}`;

// UserPromptExpansion is required alongside PostToolUse: user-typed /commands
// never produce a Skill tool_use, so tool hooks alone undercount the typed channel.
const HOOK_SPECS: { event: string; matcher?: string }[] = [
  { event: "PostToolUse", matcher: "^Skill$" },
  { event: "PostToolUse", matcher: "^(Agent|Task)$" },
  { event: "UserPromptExpansion" },
];

export interface HooksOptions {
  /** Write the edit. Default false: compute and return the diff only — the caller decides. */
  confirm?: boolean;
}

export interface HooksEdit {
  /** The settings file the edit targets. */
  path: string;
  before: string;
  after: string;
  /** Unified diff of before → after; empty when nothing changes. */
  diff: string;
  changed: boolean;
  written: boolean;
  /** The existing file could not be edited safely — nothing was or would be written. */
  error?: string;
}

type JsonObject = Record<string, unknown>;

const isObject = (x: unknown): x is JsonObject =>
  typeof x === "object" && x !== null && !Array.isArray(x);

interface LoadedSettings {
  path: string;
  before: string;
  settings?: JsonObject;
  error?: string;
}

function loadSettings(home: string): LoadedSettings {
  const path = join(home, ".claude", "settings.json");
  let before = "";
  if (existsSync(path)) {
    try {
      before = readFileSync(path, "utf8");
    } catch {
      return { path, before, error: "settings.json unreadable — not modified" };
    }
  }
  // A missing or blank file is an empty settings object; anything else must
  // parse — an edit computed over a misread file would clobber user config.
  if (!before.trim()) return { path, before, settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    return { path, before, error: "settings.json is not valid JSON — not modified" };
  }
  if (!isObject(parsed)) return { path, before, error: "settings.json is not a JSON object — not modified" };
  return { path, before, settings: parsed };
}

const detectIndent = (text: string): string => /^(\t+| +)"/m.exec(text)?.[1] ?? "  ";

const refused = (loaded: LoadedSettings, error?: string): HooksEdit => ({
  path: loaded.path,
  before: loaded.before,
  after: loaded.before,
  diff: "",
  changed: false,
  written: false,
  error: error ?? loaded.error,
});

function finishEdit(loaded: LoadedSettings, settings: JsonObject, modified: boolean, opts: HooksOptions): HooksEdit {
  // No semantic change means no edit at all — never a reformat-only write.
  if (!modified) {
    return { path: loaded.path, before: loaded.before, after: loaded.before, diff: "", changed: false, written: false };
  }
  const after = JSON.stringify(settings, null, detectIndent(loaded.before)) + "\n";
  const diff = unifiedDiff(loaded.before, after, loaded.path);
  let written = false;
  if (opts.confirm) {
    mkdirSync(dirname(loaded.path), { recursive: true });
    // Same rename dance as the ledger: a crash mid-write must not tear settings.json.
    // The rename targets the REAL file so a symlinked settings.json (dotfiles
    // repo) keeps its link; a dangling symlink falls back to the literal path,
    // matching the create-new-file behavior.
    const dest = existsSync(loaded.path) ? realpathSync(loaded.path) : loaded.path;
    const tmp = dest + ".tmp";
    writeFileSync(tmp, after);
    renameSync(tmp, dest);
    written = true;
  }
  return { path: loaded.path, before: loaded.before, after, diff, changed: true, written };
}

const entryCommands = (entry: unknown): string[] => {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return [];
  return entry.hooks
    .filter((h): h is JsonObject => isObject(h) && h.type === "command" && typeof h.command === "string")
    .map((h) => h.command as string);
};

export function hooksInstall(home: string, opts: HooksOptions = {}): HooksEdit {
  const loaded = loadSettings(home);
  if (!loaded.settings) return refused(loaded);
  const settings = loaded.settings;
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) return refused(loaded, `settings.json "hooks" is not an object — not modified`);

  let modified = false;
  for (const spec of HOOK_SPECS) {
    const existing = hooks[spec.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      return refused(loaded, `settings.json "hooks.${spec.event}" is not an array — not modified`);
    }
    const entries: unknown[] = Array.isArray(existing) ? existing : [];
    const command = hookCommand(spec.event);
    // Presence is keyed (matcher, command): both PostToolUse matchers share one
    // command, so command alone would make the second install a no-op too early.
    const present = entries.some(
      (e) =>
        entryCommands(e).includes(command) &&
        (spec.matcher === undefined || (isObject(e) && e.matcher === spec.matcher))
    );
    if (present) continue;
    entries.push(
      spec.matcher === undefined
        ? { hooks: [{ type: "command", command }] }
        : { matcher: spec.matcher, hooks: [{ type: "command", command }] }
    );
    hooks[spec.event] = entries;
    modified = true;
  }
  if (modified && settings.hooks === undefined) settings.hooks = hooks;
  return finishEdit(loaded, settings, modified, opts);
}

export function hooksUninstall(home: string, opts: HooksOptions = {}): HooksEdit {
  const loaded = loadSettings(home);
  if (!loaded.settings) return refused(loaded);
  const settings = loaded.settings;
  const hooks = settings.hooks;
  if (!isObject(hooks)) return finishEdit(loaded, settings, false, opts);

  let modified = false;
  for (const event of new Set(HOOK_SPECS.map((s) => s.event))) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const command = hookCommand(event);
    let eventModified = false;
    const kept: unknown[] = [];
    for (const e of entries) {
      if (!isObject(e) || !Array.isArray(e.hooks)) {
        kept.push(e);
        continue;
      }
      // Our command is removed wherever it appears — even if the user folded it
      // into their own entry, uninstall must stop the capture.
      const remaining = e.hooks.filter((h) => !(isObject(h) && h.type === "command" && h.command === command));
      if (remaining.length === e.hooks.length) {
        kept.push(e);
        continue;
      }
      eventModified = true;
      // Drop the entry only when it was purely ours; unknown keys mean user
      // data, which survives as an emptied entry rather than being deleted.
      if (remaining.length === 0 && Object.keys(e).every((k) => k === "matcher" || k === "hooks")) continue;
      kept.push({ ...e, hooks: remaining });
    }
    if (!eventModified) continue;
    modified = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (modified && Object.keys(hooks).length === 0) delete settings.hooks;
  return finishEdit(loaded, settings, modified, opts);
}

// --- log-event -------------------------------------------------------------

export interface LogEventResult {
  appended: number;
  skipped: number;
}

function hookToEvent(payload: unknown, eventName: string): LedgerEvent | undefined {
  if (!isObject(payload)) return undefined;
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  const project = typeof payload.cwd === "string" ? payload.cwd : "";
  const ts = new Date().toISOString();

  if (eventName === "PostToolUse") {
    const toolUseId = payload.tool_use_id;
    const input = payload.tool_input;
    if (typeof toolUseId !== "string" || toolUseId === "" || !isObject(input)) return undefined;
    let kind: AssetKind;
    let name: unknown;
    if (payload.tool_name === "Skill") {
      // Provisional hint: the payload names the tool, not the asset — the
      // Skill tool also dispatches command assets. The read-side join re-keys
      // hook events against the inventory; the stored kind never decides alone.
      kind = "skill";
      name = input.skill;
    } else if (payload.tool_name === "Agent" || payload.tool_name === "Task") {
      kind = "agent";
      name = input.subagent_type;
    } else {
      // The hook was attached wider than our matchers — record nothing.
      return undefined;
    }
    if (typeof name !== "string" || !NAME_RE.test(name)) return undefined;
    // Same id transcript ingestion derives for this tool_use, so double-capture collapses.
    return {
      v: LEDGER_SCHEMA_VERSION,
      id: `${sessionId}:${toolUseId}`,
      ts,
      provider: "claude",
      kind,
      name,
      channel: "auto",
      sessionId,
      project,
      hook: true,
    };
  }

  if (eventName === "UserPromptExpansion") {
    const raw = typeof payload.command === "string" ? payload.command : typeof payload.skill === "string" ? payload.skill : undefined;
    if (raw === undefined) return undefined;
    // First token only, slash stripped: the dispatch name is stored, args never are.
    const name = raw.trim().split(/\s+/)[0].replace(/^\//, "");
    if (!NAME_RE.test(name)) return undefined;
    return {
      v: LEDGER_SCHEMA_VERSION,
      id: `${sessionId}:${ts}:${name}`,
      ts,
      provider: "claude",
      // Provisional hint: a typed token may name a skill; the read-side join
      // re-keys against the inventory the way transcript ingestion does.
      kind: "command",
      name,
      channel: "typed",
      sessionId,
      project,
      hook: true,
    };
  }

  return undefined;
}

/**
 * Map one hook stdin payload to a ledger event and append it. Every failure
 * path returns cleanly — the CLI layer exits 0 no matter what came in.
 */
export function logEvent(stdin: string, ledger: Ledger, eventName: string): LogEventResult {
  try {
    const event = hookToEvent(JSON.parse(stdin), eventName);
    if (!event) return { appended: 0, skipped: 1 };
    return ledger.appendEvents([event]);
  } catch {
    return { appended: 0, skipped: 1 };
  }
}

// --- diff ------------------------------------------------------------------

/** Minimal unified diff — enough to show the exact edit before it is confirmed. */
function unifiedDiff(before: string, after: string, path: string): string {
  const toLines = (t: string): string[] => {
    if (t === "") return [];
    const lines = t.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const a = toLines(before);
  const b = toLines(after);
  const n = a.length;
  const m = b.length;

  // LCS over lines; settings files are small, so O(n·m) is fine.
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  interface Op {
    t: " " | "-" | "+";
    line: string;
    /** Old/new lines consumed before this op — hunk headers derive from these. */
    ob: number;
    nb: number;
  }
  const ops: Op[] = [];
  let oi = 0;
  let oj = 0;
  const push = (t: Op["t"], line: string): void => {
    ops.push({ t, line, ob: oi, nb: oj });
    if (t !== "+") oi++;
    if (t !== "-") oj++;
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(" ", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("-", a[i++]);
    else push("+", b[j++]);
  }
  while (i < n) push("-", a[i++]);
  while (j < m) push("+", b[j++]);

  const CONTEXT = 3;
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.t === " ") return;
    for (let x = Math.max(0, k - CONTEXT); x <= Math.min(ops.length - 1, k + CONTEXT); x++) keep[x] = true;
  });

  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e < ops.length && keep[e]) e++;
    const hunk = ops.slice(k, e);
    const oldCount = hunk.filter((o) => o.t !== "+").length;
    const newCount = hunk.filter((o) => o.t !== "-").length;
    const first = hunk[0];
    out.push(`@@ -${first.ob + (oldCount ? 1 : 0)},${oldCount} +${first.nb + (newCount ? 1 : 0)},${newCount} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    k = e;
  }
  return out.join("\n") + "\n";
}
