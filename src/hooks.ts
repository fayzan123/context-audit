// Opt-in real-time capture for Claude Code and Codex: `hooks install` wires the
// harness's own hook events to `context-audit log-event`, which maps each
// payload to a ledger event. Install never writes without explicit confirm —
// the caller prints the diff and decides. log-event never throws: a broken
// hook must never break the user's session.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_NAME_RE, LEDGER_SCHEMA_VERSION, NAME_RE } from "./ledger.js";
import type { Ledger } from "./ledger.js";
import type { AssetKind, LedgerEvent } from "./types.js";

/** Harnesses whose hook engines this tool can write. */
export type HookProvider = "claude" | "codex";

/** The exact command each installed hook runs — also the uninstall match key. */
const hookCommand = (event: string): string => `context-audit log-event --claude-hook ${event}`;

// UserPromptExpansion is required alongside PostToolUse: user-typed /commands
// never produce a Skill tool_use, so tool hooks alone undercount the typed channel.
const HOOK_SPECS: { event: string; matcher?: string }[] = [
  { event: "PostToolUse", matcher: "^Skill$" },
  { event: "PostToolUse", matcher: "^(Agent|Task)$" },
  { event: "UserPromptExpansion" },
];

/**
 * Codex's hook event keys are PascalCase, and a snake_case key (`user_prompt_
 * submit`) parses without any warning while registering ZERO hooks — a silent
 * no-op verified against codex-cli 0.144.4. The casing here is load-bearing.
 */
const CODEX_HOOK_EVENT = "UserPromptSubmit";

/**
 * UserPromptSubmit is the ONLY hook installed for Codex. Codex has no dedicated
 * skill-dispatch tool — its one tool is `exec` — so a PostToolUse hook would
 * spawn a process on every shell command to recover a signal the rollout scan
 * already captures exactly, and Codex does not purge its rollouts (they reach
 * back to March on the reference machine). The >30-day loss window that hooks
 * exist to close does not exist on this side.
 */
const codexHookCommand = `context-audit log-event --codex-hook ${CODEX_HOOK_EVENT}`;

/**
 * A Codex typed dispatch: the leading slash the user types, then exactly the
 * names the ledger can durably store (ledger.ts's STORE_NAME_RE — the rule
 * `isLedgerEvent` applies to every kind but `agent`). Nothing narrower is safe
 * here. Codex prompt names are bare file stems (`sources/codex.ts` derives the
 * name from the filename) and the rollout scan gates them on nothing, so a
 * leading-LETTER rule refused `/2fa` while the scan matched it — and because a
 * hook-owned session has its scan-derived typed events dropped (invariant 2),
 * the fire was not merely uncounted, it was DELETED: the row showed 1 window
 * fire beside 0 lifetime fires. The dotted names Codex allows (release.notes)
 * are admitted for the same reason.
 *
 * The leading slash is still required and still load-bearing: this payload
 * carries the raw prompt, so without it every English sentence would bank a
 * fire named after its first word. A second "/" (a pasted absolute path) and
 * anything shaped like args or prose still fail the character class.
 */
const CODEX_TYPED_TOKEN_RE = /^\/[A-Za-z0-9:._-]+$/;

/** Written only into a file that has no description of its own, and removed by uninstall. */
const CODEX_DESCRIPTION = "context-audit — records typed prompt dispatches in the local usage ledger";

/** Where Codex reads its hook registrations from. */
export const codexHooksPath = (home: string): string => join(home, ".codex", "hooks.json");

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

/**
 * Both harnesses' config files are JSON objects we merge into, and both must
 * refuse rather than guess: a file we cannot parse is a file whose user content
 * an edit computed over it would silently clobber. `label` is the file name the
 * refusal quotes, so the user knows which file stopped the edit.
 */
function loadJsonConfig(path: string, label: string): LoadedSettings {
  let before = "";
  if (existsSync(path)) {
    try {
      before = readFileSync(path, "utf8");
    } catch {
      return { path, before, error: `${label} unreadable — not modified` };
    }
  }
  // A missing or blank file is an empty config object; anything else must parse.
  if (!before.trim()) return { path, before, settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    return { path, before, error: `${label} is not valid JSON — not modified` };
  }
  if (!isObject(parsed)) return { path, before, error: `${label} is not a JSON object — not modified` };
  return { path, before, settings: parsed };
}

const loadSettings = (home: string): LoadedSettings =>
  loadJsonConfig(join(home, ".claude", "settings.json"), "settings.json");

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
  // Tested on the STORED value, never on a `?? {}` substitute: `??` treats an
  // explicit `null` as absent, and the entries would then be pushed into a
  // throwaway object while `settings.hooks` stayed null — an install that
  // reports success, writes the file, registers nothing, and claims to install
  // again on every rerun. A shape this writer does not recognize is refused.
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    return refused(loaded, `settings.json "hooks" is not an object — not modified`);
  }
  const hooks: JsonObject = settings.hooks ?? {};

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
  // Identity, not `=== undefined`: the only case that needs attaching is the
  // one where `hooks` is the object created above.
  if (modified && settings.hooks !== hooks) settings.hooks = hooks;
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

// --- codex -----------------------------------------------------------------
// Same compute-then-confirm contract as the Claude writer, against a different
// file shape: ~/.codex/hooks.json's top level is an OBJECT carrying
// `description` and `hooks` — the event map is NOT the top level, and a file
// written in the Claude shape registers nothing.

export function codexHooksInstall(home: string, opts: HooksOptions = {}): HooksEdit {
  const loaded = loadJsonConfig(codexHooksPath(home), "hooks.json");
  if (!loaded.settings) return refused(loaded);
  const root = loaded.settings;
  // The STORED value decides, so that an explicit `"hooks": null` is refused
  // like `"hooks": 42` is. Under `root.hooks ?? {}` it was neither: the entry
  // went into a throwaway object, the write-back guard (`=== undefined`) did
  // not fire for null, and install printed "written: …" plus the trust notice
  // over a file that still registered no hook — every rerun claiming to
  // install it again. A malformed hooks.json is refused, never half-written.
  if (root.hooks !== undefined && !isObject(root.hooks)) {
    return refused(loaded, `hooks.json "hooks" is not an object — not modified`);
  }
  const hooks: JsonObject = root.hooks ?? {};
  const existing = hooks[CODEX_HOOK_EVENT];
  if (existing !== undefined && !Array.isArray(existing)) {
    return refused(loaded, `hooks.json "hooks.${CODEX_HOOK_EVENT}" is not an array — not modified`);
  }
  const entries: unknown[] = Array.isArray(existing) ? existing : [];
  // UserPromptSubmit takes no matcher (matchers select tools), so the command
  // alone identifies our entry — including one a user folded into their own.
  if (entries.some((e) => entryCommands(e).includes(codexHookCommand))) {
    return finishEdit(loaded, root, false, opts);
  }
  entries.push({ hooks: [{ type: "command", command: codexHookCommand }] });
  hooks[CODEX_HOOK_EVENT] = entries;
  // Codex's own file carries a description; a file we created gets one naming
  // us, so a user reading ~/.codex/hooks.json later knows what put it there.
  // Never overwritten — the user's own description is their text. Assigned
  // before `hooks` so a file we create matches the documented key order.
  if (typeof root.description !== "string") root.description = CODEX_DESCRIPTION;
  if (root.hooks !== hooks) root.hooks = hooks;
  return finishEdit(loaded, root, true, opts);
}

export function codexHooksUninstall(home: string, opts: HooksOptions = {}): HooksEdit {
  const loaded = loadJsonConfig(codexHooksPath(home), "hooks.json");
  if (!loaded.settings) return refused(loaded);
  const root = loaded.settings;
  const hooks = root.hooks;
  if (!isObject(hooks)) return finishEdit(loaded, root, false, opts);
  const entries = hooks[CODEX_HOOK_EVENT];
  if (!Array.isArray(entries)) return finishEdit(loaded, root, false, opts);

  let modified = false;
  const kept: unknown[] = [];
  for (const e of entries) {
    if (!isObject(e) || !Array.isArray(e.hooks)) {
      kept.push(e);
      continue;
    }
    // Our command goes wherever it sits — a user who folded it into their own
    // entry still gets the capture stopped.
    const remaining = e.hooks.filter(
      (h) => !(isObject(h) && h.type === "command" && h.command === codexHookCommand)
    );
    if (remaining.length === e.hooks.length) {
      kept.push(e);
      continue;
    }
    modified = true;
    // An entry emptied of everything but our command was ours; one carrying
    // unknown keys is user data and survives as an emptied entry.
    if (remaining.length === 0 && Object.keys(e).every((k) => k === "matcher" || k === "hooks")) continue;
    kept.push({ ...e, hooks: remaining });
  }
  if (!modified) return finishEdit(loaded, root, false, opts);
  if (kept.length === 0) delete hooks[CODEX_HOOK_EVENT];
  else hooks[CODEX_HOOK_EVENT] = kept;
  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
    // Uninstall removes exactly what install added, and the description is
    // ours only while it is still byte-identical to what we wrote.
    if (root.description === CODEX_DESCRIPTION) delete root.description;
  }
  return finishEdit(loaded, root, true, opts);
}

// --- log-event -------------------------------------------------------------

export interface LogEventResult {
  appended: number;
  skipped: number;
  /**
   * Refused by the ledger's durable built-ins preference — held apart from
   * `skipped` so a caller can never report a dropped built-in as "already
   * recorded".
   */
  droppedBuiltins: number;
}

function claudeHookToEvent(payload: unknown, eventName: string): LedgerEvent | undefined {
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
    // Gate selected by kind, exactly as transcript ingestion selects it: a
    // Skill dispatch is a token (NAME_RE), an `Agent`/`Task` dispatch is the
    // structured `subagent_type` the harness filled from a registered
    // frontmatter name (AGENT_NAME_RE). Installing hooks was never a way around
    // the old defect — both writers share these constants, so a fix to one that
    // is not a fix to the other is not a fix.
    if (typeof name !== "string" || !(kind === "agent" ? AGENT_NAME_RE : NAME_RE).test(name)) return undefined;
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
    // NAME_RE, and NOT the agent rule — this is the site the privacy boundary
    // exists for. `raw` is a line the USER TYPED, and the split above is what
    // separates the dispatch name from arguments that may carry client paths or
    // secrets; this test is the backstop behind that split. Applying
    // AGENT_NAME_RE here would admit "impeccable teach --project ~/clients/acme"
    // to a durable on-disk file.
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
 * Codex's hook stdin is snake_case and Claude-compatible. UserPromptSubmit is
 * the only event installed (see CODEX_HOOK_EVENT), and it fires on EVERY user
 * turn carrying the raw prompt — the one payload field in either harness that
 * is free text. Only its first whitespace-delimited token is ever looked at,
 * and only a token that is a slash dispatch survives: prose, questions and
 * pasted paths produce no event at all, and nothing but the bare name reaches
 * the ledger. Same shape the rollout scan matches (`/name`), so the hook and
 * the scan agree about what a Codex prompt fire even is.
 */
function codexHookToEvent(payload: unknown, eventName: string): LedgerEvent | undefined {
  if (!isObject(payload) || eventName !== CODEX_HOOK_EVENT) return undefined;
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  const raw = payload.prompt;
  if (typeof raw !== "string") return undefined;
  const token = raw.trim().split(/\s+/)[0];
  if (!CODEX_TYPED_TOKEN_RE.test(token)) return undefined;
  const name = token.slice(1);
  // Read once: two calls could straddle a millisecond and put an id in the
  // store that its own ts cannot reproduce.
  const ts = new Date().toISOString();
  return {
    v: LEDGER_SCHEMA_VERSION,
    // The hook's clock is not the rollout's: the scan reads its timestamp from
    // the rollout record, this one is stamped at dispatch, so the two ids do
    // NOT collapse the way a tool_use id does. What keeps a Codex prompt from
    // being counted twice is the session-level exclusion (invariant 2) — a
    // session owned by a hook must have its scan-derived typed events dropped.
    id: `${sessionId}:${ts}:${name}`,
    ts,
    provider: "codex",
    // Provisional hint, like the Claude writer's: Codex dispatches prompts by
    // name and the read-side join re-keys against the current inventory.
    kind: "prompt",
    name,
    channel: "typed",
    sessionId,
    project: typeof payload.cwd === "string" ? payload.cwd : "",
    hook: true,
  };
}

/**
 * Map one hook stdin payload to a ledger event and append it. Every failure
 * path returns cleanly — the CLI layer exits 0 no matter what came in.
 */
export function logEvent(
  stdin: string,
  ledger: Ledger,
  eventName: string,
  provider: HookProvider = "claude"
): LogEventResult {
  const nothing: LogEventResult = { appended: 0, skipped: 1, droppedBuiltins: 0 };
  try {
    const payload = JSON.parse(stdin);
    // Both harnesses name an event UserPromptSubmit, so the event name alone
    // cannot pick the mapper — the installed command states which harness it
    // was installed into.
    const event =
      provider === "codex" ? codexHookToEvent(payload, eventName) : claudeHookToEvent(payload, eventName);
    if (!event) return nothing;
    return ledger.appendEvents([event]);
  } catch {
    return nothing;
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
