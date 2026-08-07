#!/usr/bin/env node
// Unit corpus for the opt-in hooks channel (src/hooks.ts):
//   - install computes the settings.json edit, writes only on confirm
//   - install twice adds each entry once; uninstall restores byte-identically
//   - merge preserves pre-existing unrelated hooks and unknown keys
//   - corrupt settings.json refuses the edit, never clobbers
//   - a symlinked settings.json keeps its link; edits land in the real target
//   - log-event maps valid payloads, dedupes, and NEVER stores args/prompts
//   - the name gate PER CHANNEL, shared with transcript ingestion: a registered
//     agent's prose subagent_type is banked, a control character or an
//     81-character one is not, and the typed-command site is UNCHANGED
//   - every hook-written event is stamped hook:true, durably
// and for the Codex writer (a different file shape, one installed event):
//   - hooks.json is written byte-for-byte in the shape codex-cli registers,
//     PascalCase event key included
//   - install is idempotent (even folded into a user's own entry), refuses
//     anything it cannot parse or recognize, and never writes without confirm
//   - uninstall removes our command wherever a user put it, keeping theirs
//   - log-event banks the dispatch TOKEN of a UserPromptSubmit prompt and
//     nothing else — that payload carries the user's raw prompt on every turn
// Fixture homes are COPIED into mkdtemp dirs before editing and every ledger
// gets an injected base — the real $HOME is never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "hooks");
const { hooksInstall, hooksUninstall, codexHooksInstall, codexHooksUninstall, codexHooksPath, logEvent } =
  await import(pathToFileURL(join(root, "dist", "hooks.js")).href);
const { openLedger } = await import(pathToFileURL(join(root, "dist", "ledger.js")).href);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};

const tmps = [];
const freshHome = () => {
  const d = mkdtempSync(join(tmpdir(), "context-audit-hooks-"));
  tmps.push(d);
  return d;
};
const fixtureHome = (name) => {
  const d = freshHome();
  cpSync(join(fixtures, name), d, { recursive: true });
  return d;
};

const settingsPath = (home) => join(home, ".claude", "settings.json");
const readSettings = (home) => JSON.parse(readFileSync(settingsPath(home), "utf8"));
const payload = (name) => readFileSync(join(fixtures, "payloads", name), "utf8");

const POST_CMD = "context-audit log-event --claude-hook PostToolUse";
const PROMPT_CMD = "context-audit log-event --claude-hook UserPromptExpansion";
const ourEntries = (settings) => {
  const post = (settings.hooks?.PostToolUse ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => h.command === POST_CMD)
  );
  const prompt = (settings.hooks?.UserPromptExpansion ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => h.command === PROMPT_CMD)
  );
  return { post, prompt };
};

// --- install on a fresh home ------------------------------------------------
console.log("INSTALL (fresh home):");
{
  const home = freshHome();
  const dry = hooksInstall(home);
  check("dry run reports a change", dry.changed && !dry.written && !dry.error);
  check("dry run does not create the file", !existsSync(settingsPath(home)));
  check("diff carries the hook commands", dry.diff.includes(POST_CMD) && dry.diff.includes(PROMPT_CMD));
  check("diff is unified-shaped", dry.diff.startsWith(`--- ${settingsPath(home)}\n+++ `) && dry.diff.includes("\n@@ "));

  const wet = hooksInstall(home, { confirm: true });
  check("confirm writes the file", wet.written && existsSync(settingsPath(home)));
  check("written text matches the returned after", readFileSync(settingsPath(home), "utf8") === wet.after);
  const s = readSettings(home);
  const { post, prompt } = ourEntries(s);
  check("two PostToolUse entries land", post.length === 2, JSON.stringify(s.hooks?.PostToolUse));
  check(
    "matchers cover Skill and Agent|Task",
    post.map((e) => e.matcher).sort().join(",") === "^(Agent|Task)$,^Skill$"
  );
  check("one UserPromptExpansion entry lands", prompt.length === 1 && prompt[0].matcher === undefined);

  // --- idempotency ----------------------------------------------------------
  console.log("INSTALL IDEMPOTENCY:");
  const again = hooksInstall(home, { confirm: true });
  check("second install is a no-op", !again.changed && !again.written && again.diff === "");
  const s2 = readSettings(home);
  const e2 = ourEntries(s2);
  check("still exactly one entry per hook", e2.post.length === 2 && e2.prompt.length === 1);

  // --- uninstall restores ---------------------------------------------------
  console.log("UNINSTALL (fresh home):");
  const un = hooksUninstall(home, { confirm: true });
  check("uninstall reports a change and writes", un.changed && un.written);
  check("hooks key removed when nothing else used it", !("hooks" in readSettings(home)));
  const unAgain = hooksUninstall(home, { confirm: true });
  check("second uninstall is a no-op", !unAgain.changed && !unAgain.written);
}

// --- merge with pre-existing settings ---------------------------------------
console.log("MERGE (existing-home fixture):");
{
  const home = fixtureHome("existing-home");
  const original = readFileSync(settingsPath(home), "utf8");
  const inst = hooksInstall(home, { confirm: true });
  check("install into existing settings writes", inst.changed && inst.written);
  const s = readSettings(home);
  check(
    "pre-existing Bash hook survives",
    s.hooks.PostToolUse.some((e) => e.matcher === "^Bash$" && e.hooks[0].command === "echo user-hook" && e.note)
  );
  check("unrelated keys survive", s.model === "opus" && s.unknownTopLevelKey?.keep === true && s.permissions.allow[0] === "Bash(npm run build)");
  check("our entries added alongside", s.hooks.PostToolUse.length === 3 && ourEntries(s).prompt.length === 1);

  const un = hooksUninstall(home, { confirm: true });
  check("uninstall restores the file byte-identically", readFileSync(settingsPath(home), "utf8") === original, un.diff);
}

// --- refusal on unreadable settings -----------------------------------------
console.log("CORRUPT SETTINGS (corrupt-home fixture):");
{
  const home = fixtureHome("corrupt-home");
  const original = readFileSync(settingsPath(home), "utf8");
  const inst = hooksInstall(home, { confirm: true });
  check("install refuses with an error", !!inst.error && !inst.changed && !inst.written, inst.error);
  check("file untouched even with confirm", readFileSync(settingsPath(home), "utf8") === original);
  const un = hooksUninstall(home, { confirm: true });
  check("uninstall refuses too", !!un.error && !un.written);
}

// --- uninstall with nothing installed ---------------------------------------
{
  const home = freshHome();
  const un = hooksUninstall(home, { confirm: true });
  check("uninstall on empty home is a clean no-op", !un.changed && !un.written && !existsSync(settingsPath(home)));
}

// --- symlinked settings.json (finding #15) ----------------------------------
// A settings.json symlinked into a dotfiles repo must keep its link: the
// atomic rename targets the resolved real file, never the symlink entry.
if (process.platform !== "win32") {
  console.log("SYMLINKED SETTINGS:");
  const home = freshHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  const target = join(home, "dotfiles-settings.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, settingsPath(home));

  const inst = hooksInstall(home, { confirm: true });
  check("install through a symlink writes", inst.changed && inst.written && !inst.error);
  check("settings.json is still a symlink after install", lstatSync(settingsPath(home)).isSymbolicLink());
  check("the link target received the edit", readFileSync(target, "utf8") === inst.after);

  const un = hooksUninstall(home, { confirm: true });
  check("settings.json is still a symlink after uninstall", un.written && lstatSync(settingsPath(home)).isSymbolicLink());
  check("uninstall restored the target byte-identically", readFileSync(target, "utf8") === "{}\n");

  // Dangling symlink: nothing to resolve, so the literal path is written —
  // the link is replaced by a regular file, same as before the fix.
  const home2 = freshHome();
  mkdirSync(join(home2, ".claude"), { recursive: true });
  symlinkSync(join(home2, "missing-target.json"), settingsPath(home2));
  const inst2 = hooksInstall(home2, { confirm: true });
  check(
    "dangling symlink: install writes a regular file at the literal path",
    inst2.written && !lstatSync(settingsPath(home2)).isSymbolicLink() && existsSync(settingsPath(home2))
  );
}

// --- log-event: valid payloads ----------------------------------------------
console.log("LOG-EVENT (valid payloads):");
{
  const base = freshHome();
  const ledger = openLedger(base);

  const r1 = logEvent(payload("skill.json"), ledger, "PostToolUse");
  check("skill payload appends", r1.appended === 1 && r1.skipped === 0, JSON.stringify(r1));
  const skill = ledger.readEvents({ kind: "skill" })[0];
  check(
    "skill event carries the transcript-convergent id",
    skill?.id === "sess-1:toolu_abc123" && skill.provider === "claude" && skill.channel === "auto"
  );
  check("skill event records name and project only", skill.name === "impeccable" && skill.project === "/Users/someone/proj");
  check("skill event is stamped hook:true", skill.hook === true);

  const r2 = logEvent(payload("skill.json"), ledger, "PostToolUse");
  check("duplicate tool_use_id is skipped", r2.appended === 0 && r2.skipped === 1, JSON.stringify(r2));

  const r3 = logEvent(payload("agent.json"), ledger, "PostToolUse");
  const agent = ledger.readEvents({ kind: "agent" })[0];
  check(
    "agent payload maps subagent_type",
    r3.appended === 1 && agent?.name === "code-reviewer" && agent.id === "sess-1:toolu_def456"
  );
  check("agent event is stamped hook:true", agent.hook === true);

  // The hook writer applies the SAME per-channel pair transcript ingestion
  // does — it shares the constants, so a fix to one writer is not a fix to the
  // other. Installing hooks was never a way around the old defect: both dropped
  // every registerable agent name.
  const r3b = logEvent(payload("agent-spaced.json"), ledger, "PostToolUse");
  const spaced = ledger.readEvents({ kind: "agent", name: "LinkedIn Content Creator" });
  check(
    "a registered agent's prose name is banked by the hook writer",
    r3b.appended === 1 && spaced.length === 1 && spaced[0].id === "sess-1:toolu_li0001",
    JSON.stringify(r3b) + JSON.stringify(spaced)
  );
  const r3c = logEvent(payload("agent-task-spaced.json"), ledger, "PostToolUse");
  check(
    "the older Task spelling is banked the same way",
    r3c.appended === 1 && ledger.readEvents({ kind: "agent", name: "Backend Architect" }).length === 1,
    JSON.stringify(r3c)
  );

  const r4 = logEvent(payload("prompt.json"), ledger, "UserPromptExpansion");
  const cmd = ledger.readEvents({ kind: "command" })[0];
  check("prompt expansion appends a typed command", r4.appended === 1 && cmd?.channel === "typed");
  check("slash stripped, first token only", cmd.name === "impeccable");
  check("typed id follows sessionId:ts:name", /^sess-2:\d{4}-\d{2}-\d{2}T.*:impeccable$/.test(cmd.id), cmd.id);
  check("typed event is stamped hook:true", cmd.hook === true);
  check(
    "hook marker survives reopen (durable, not in-memory)",
    openLedger(base).readEvents().every((e) => e.hook === true)
  );

  // The exact line the design cites, replayed now that a laxer rule exists on
  // the agent channel: the typed site still stores the token and nothing behind
  // it. Applying the agent rule here would have banked a client path.
  const r4b = logEvent(payload("prompt-client-path.json"), ledger, "UserPromptExpansion");
  check(
    "a typed command with args banks the token only",
    r4b.appended === 1 && ledger.readEvents({ sessionId: "sess-3" })[0]?.name === "impeccable",
    JSON.stringify(ledger.readEvents({ sessionId: "sess-3" }))
  );

  // --- no content ever stored ----------------------------------------------
  console.log("LOG-EVENT (content never stored):");
  const usage = join(base, "usage");
  const stored = readdirSync(usage)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(usage, f), "utf8"))
    .join("");
  check("no args, prompts, or tails reach disk", stored.length > 0 && !stored.includes("SECRET"));
  check("no client path from a typed line reaches disk", !stored.includes("clients/acme"));

  // --- malformed payloads never throw, never append -------------------------
  console.log("LOG-EVENT (malformed payloads):");
  const before = ledger.readEvents().length;
  const cases = [
    ["not JSON at all", "this is { not json"],
    ["empty stdin", ""],
    ["missing session_id", payload("missing-session.json")],
    ["tool outside the matchers", payload("wrong-tool.json")],
    ["shell metacharacters in the name", payload("args-in-name.json")],
    // What the agent channel still refuses: U+0000 is the usage join-key
    // separator, so a name carrying one could forge a join onto another
    // asset's row, and 81 characters is a prose blob, not a dispatch name.
    ["a control character in subagent_type", payload("agent-control-char.json")],
    ["an 81-character subagent_type", payload("agent-too-long.json")],
    // The site the privacy boundary exists for is UNCHANGED: a typed line is
    // split to its first token and NAME_RE is the backstop behind the split,
    // so a path-shaped token is refused rather than banked.
    ["a path-shaped typed token", payload("prompt-path-token.json"), "UserPromptExpansion"],
    ["unknown hook event", payload("skill.json"), "Stop"],
    ["JSON scalar", "42"],
  ];
  for (const [name, stdin, event = "PostToolUse"] of cases) {
    let r;
    let threw = false;
    try {
      r = logEvent(stdin, ledger, event);
    } catch {
      threw = true;
    }
    check(`${name} returns cleanly`, !threw && r.appended === 0 && r.skipped === 1, JSON.stringify(r));
  }
  check("malformed payloads appended nothing", ledger.readEvents().length === before);
}

// === CODEX ==================================================================
// A different harness, a different file, one installed event. Everything below
// is pinned against the shape verified empirically on codex-cli 0.144.4 by
// writing candidate files and asking the harness what it registered
// (`codex app-server` -> `hooks/list`) — guessing here fails SILENTLY.
const codexPayload = (name) => readFileSync(join(fixtures, "codex", "payloads", name), "utf8");
const codexHome = (name) => fixtureHome(join("codex", name));

/** The exact command installed — `--codex-hook` is what selects the Codex payload mapper. */
const CODEX_CMD = "context-audit log-event --codex-hook UserPromptSubmit";
const CODEX_DESC = "context-audit — records typed prompt dispatches in the local usage ledger";
/**
 * The whole file, byte for byte. The top level is an OBJECT carrying
 * `description` and `hooks` — the event map is NOT the top level, and a file
 * written in Claude's settings.json shape registers nothing.
 */
const CODEX_FILE =
  JSON.stringify(
    {
      description: CODEX_DESC,
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: CODEX_CMD }] }] },
    },
    null,
    2
  ) + "\n";

console.log("CODEX INSTALL (fresh home):");
{
  const home = freshHome();
  const path = codexHooksPath(home);
  check("hooks.json path is ~/.codex/hooks.json", path === join(home, ".codex", "hooks.json"), path);

  const dry = codexHooksInstall(home);
  check("dry run reports a change", dry.changed && !dry.written && !dry.error);
  // Never auto-installs: without confirm not even the .codex directory appears.
  check("dry run creates neither the file nor the directory", !existsSync(path) && !existsSync(join(home, ".codex")));
  check("diff carries the codex command", dry.diff.includes(CODEX_CMD));
  check("diff is unified-shaped", dry.diff.startsWith(`--- ${path}\n+++ `) && dry.diff.includes("\n@@ "));

  const wet = codexHooksInstall(home, { confirm: true });
  check("confirm writes the file", wet.written && existsSync(path));
  check("written text matches the returned after", readFileSync(path, "utf8") === wet.after);
  check("the written file is EXACTLY the verified codex shape", readFileSync(path, "utf8") === CODEX_FILE, readFileSync(path, "utf8"));

  const root = JSON.parse(readFileSync(path, "utf8"));
  check(
    "top level is an object of description + hooks, in that order — not the event map",
    Object.keys(root).join(",") === "description,hooks",
    Object.keys(root).join(",")
  );
  // Casing is load-bearing and its failure mode is silent: a snake_case event
  // key (`user_prompt_submit`) parses WITHOUT a warning and registers ZERO
  // hooks, so a casing regression ships a tool that reports success, writes a
  // file the user can read, and captures nothing forever. Verified both ways.
  check(
    "the event key is PascalCase UserPromptSubmit (snake_case registers zero hooks, silently)",
    Object.keys(root.hooks).join(",") === "UserPromptSubmit",
    Object.keys(root.hooks).join(",")
  );
  const entry = root.hooks.UserPromptSubmit[0];
  check("exactly one entry, carrying no matcher (matchers select tools; this event has none)", root.hooks.UserPromptSubmit.length === 1 && entry.matcher === undefined);
  check("the handler is a single {type:'command', command}", entry.hooks.length === 1 && entry.hooks[0].type === "command");
  // --codex-hook (not --claude-hook) is what routes stdin to the Codex mapper:
  // both harnesses name an event UserPromptSubmit, so the flag is the only
  // thing that says which payload shape arrives.
  check("the command names --codex-hook, the flag that selects the codex mapper", entry.hooks[0].command === CODEX_CMD, entry.hooks[0].command);
  // Only UserPromptSubmit is installed: Codex's one tool is `exec`, so a
  // PostToolUse hook would spawn a process on every shell command to recover
  // what the rollout scan already reads exactly.
  check("no PostToolUse hook is installed", root.hooks.PostToolUse === undefined);

  console.log("CODEX INSTALL IDEMPOTENCY:");
  const again = codexHooksInstall(home, { confirm: true });
  check("second install is a no-op", !again.changed && !again.written && again.diff === "");
  check("file untouched by the second install", readFileSync(path, "utf8") === CODEX_FILE);

  console.log("CODEX UNINSTALL (fresh home):");
  const un = codexHooksUninstall(home, { confirm: true });
  check("uninstall reports a change and writes", un.changed && un.written);
  check("every key we added is gone", readFileSync(path, "utf8") === "{}\n", readFileSync(path, "utf8"));
  const unAgain = codexHooksUninstall(home, { confirm: true });
  check("second uninstall is a no-op", !unAgain.changed && !unAgain.written);
}

{
  const home = freshHome();
  const un = codexHooksUninstall(home, { confirm: true });
  check(
    "uninstall on a home with no hooks.json is a clean no-op",
    !un.changed && !un.written && !un.error && !existsSync(codexHooksPath(home))
  );
}

// --- merge with a user's own codex hooks ------------------------------------
console.log("CODEX MERGE (existing-home fixture):");
{
  const home = codexHome("existing-home");
  const path = codexHooksPath(home);
  const original = readFileSync(path, "utf8");

  const dry = codexHooksInstall(home);
  check("dry run against an existing file writes nothing", dry.changed && !dry.written && readFileSync(path, "utf8") === original);

  const inst = codexHooksInstall(home, { confirm: true });
  check("install into an existing file writes", inst.changed && inst.written && !inst.error);
  const root = JSON.parse(readFileSync(path, "utf8"));
  // The description is the user's text; ours is written only into a file that
  // has none, so a real Codex config keeps saying what its owner wrote.
  check("the user's own description is never overwritten", root.description === "my own codex hooks — this text is mine and must survive");
  check(
    "the user's PostToolUse entry survives whole (matcher, timeout, unknown keys)",
    root.hooks.PostToolUse.length === 1 &&
      root.hooks.PostToolUse[0].matcher === "^exec$" &&
      root.hooks.PostToolUse[0].hooks[0].timeout === 30 &&
      !!root.hooks.PostToolUse[0].note
  );
  check("unrelated top-level keys survive", root.unknownTopLevelKey?.keep === true);
  const ours = root.hooks.UserPromptSubmit.filter((e) => (e.hooks ?? []).some((h) => h.command === CODEX_CMD));
  check(
    "the user's own UserPromptSubmit entry survives and ours is added alongside, once",
    root.hooks.UserPromptSubmit.length === 2 && ours.length === 1 &&
      root.hooks.UserPromptSubmit[0].hooks[0].command === "echo user-prompt-hook"
  );

  const un = codexHooksUninstall(home, { confirm: true });
  check("uninstall restores the file byte-identically", readFileSync(path, "utf8") === original, un.diff);
}

// --- our command folded into the user's own entries -------------------------
// A user may move our command into an entry of their own (to add statusMessage,
// async, or to run it beside their own hook). Install must still see it — a
// second registration would double-count every typed prompt — and uninstall
// must still stop the capture wherever it ended up.
console.log("CODEX FOLDED COMMAND (folded-home fixture):");
{
  const home = codexHome("folded-home");
  const path = codexHooksPath(home);
  const original = readFileSync(path, "utf8");

  const inst = codexHooksInstall(home, { confirm: true });
  check("install is a no-op when our command is folded into a user's entry", !inst.changed && !inst.written);
  check("...and the file is untouched", readFileSync(path, "utf8") === original);

  const un = codexHooksUninstall(home, { confirm: true });
  check("uninstall reports a change and writes", un.changed && un.written);
  const after = readFileSync(path, "utf8");
  check("our command appears nowhere afterwards", !after.includes(CODEX_CMD), after);
  const root = JSON.parse(after);
  // An entry that held only our command still carries user data (statusMessage),
  // so it survives emptied rather than being deleted out from under them.
  check(
    "an entry carrying user keys survives with an emptied hooks list",
    root.hooks.UserPromptSubmit[0].statusMessage === "recording usage" &&
      root.hooks.UserPromptSubmit[0].hooks.length === 0
  );
  check(
    "the user's own handler in the shared entry survives",
    root.hooks.UserPromptSubmit[1].hooks.length === 1 &&
      root.hooks.UserPromptSubmit[1].hooks[0].command === "echo user-prompt-hook"
  );
  check("the user's description survives (other hooks remain)", root.description === "my own codex hooks — this text is mine and must survive");
}

// --- refusals ---------------------------------------------------------------
// A file this tool cannot parse, or whose shape it does not recognize, is a
// file full of user content an edit computed over it would silently clobber.
console.log("CODEX REFUSALS (unparseable / unexpected shapes):");
{
  const cases = [
    ["not valid JSON", '{ "hooks": { "UserPromptSubmit": [ this is not json\n'],
    ["a top-level array", '[{ "hooks": {} }]\n'],
    ["a top-level scalar", '"just a string"\n'],
    ['"hooks" is not an object', '{ "description": "mine", "hooks": 42 }\n'],
    ['"hooks.UserPromptSubmit" is not an array', '{ "hooks": { "UserPromptSubmit": { "hooks": [] } } }\n'],
  ];
  for (const [name, text] of cases) {
    const home = freshHome();
    const path = codexHooksPath(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(path, text);

    const inst = codexHooksInstall(home, { confirm: true });
    check(
      `install refuses ${name} and names the file`,
      !!inst.error && /hooks\.json/.test(inst.error) && !inst.changed && !inst.written,
      inst.error
    );
    check(`${name}: file untouched even with confirm`, readFileSync(path, "utf8") === text);
    const un = codexHooksUninstall(home, { confirm: true });
    check(`uninstall writes nothing over ${name}`, !un.written && readFileSync(path, "utf8") === text);
  }
}

// --- codex log-event --------------------------------------------------------
// The highest-value assertions in this file. Codex's UserPromptSubmit fires on
// EVERY user turn and its payload carries the raw prompt — the one field in
// either harness that is free text the user typed. Only the leading dispatch
// token may ever reach the ledger.
console.log("CODEX LOG-EVENT (dispatch token only):");
{
  const base = freshHome();
  const ledger = openLedger(base);

  const r1 = logEvent(codexPayload("prompt-secret.json"), ledger, "UserPromptSubmit", "codex");
  check("a slash-dispatch prompt appends one event", r1.appended === 1 && r1.skipped === 0 && r1.droppedBuiltins === 0, JSON.stringify(r1));
  const ev = ledger.readEvents()[0];
  check(
    "mapped as a typed codex prompt fire",
    ev?.provider === "codex" && ev.kind === "prompt" && ev.channel === "typed" && ev.sessionId === "cx-sess-1" && ev.project === "/Users/someone/proj",
    JSON.stringify(ev)
  );
  check("the name is the bare token — no slash, no arguments", ev.name === "deploy");
  // The hook's clock is not the rollout's, so this id cannot collapse against
  // the scan's the way a tool_use id does; the session-level exclusion is what
  // prevents double counting.
  check("id follows sessionId:ts:name", /^cx-sess-1:\d{4}-\d{2}-\d{2}T[\d:.]+Z:deploy$/.test(ev.id), ev.id);
  check("stamped hook:true", ev.hook === true);
  check(
    "the event carries these fields and NOTHING else",
    Object.keys(ev).sort().join(",") === "channel,hook,id,kind,name,project,provider,sessionId,ts,v",
    Object.keys(ev).sort().join(",")
  );

  const r2 = logEvent(codexPayload("dotted.json"), ledger, "UserPromptSubmit", "codex");
  // Codex prompt and skill names legitimately carry "." — the rollout scan
  // matches them, so a hook that dropped them would LOSE the fire outright
  // (a hook-owned session has its scan-derived typed events excluded).
  check("a dotted prompt name is admitted", r2.appended === 1 && ledger.readEvents({ name: "release.notes" }).length === 1);
  check("its arguments are still dropped", !ledger.readEvents().some((e) => e.name.includes("2.1.0")));

  // Claude Code's built-ins list is Claude Code's: a Codex prompt named
  // `status` is a real asset in the inventory and joins to a real row.
  const r3 = logEvent(codexPayload("builtin-name.json"), ledger, "UserPromptSubmit", "codex");
  check(
    "a codex prompt named like a Claude built-in is banked, not dropped",
    r3.appended === 1 && r3.droppedBuiltins === 0 && ledger.readEvents({ provider: "codex", name: "status" }).length === 1,
    JSON.stringify(r3)
  );

  check(
    "hook marker survives reopen (durable, not in-memory)",
    openLedger(base).readEvents().every((e) => e.hook === true)
  );

  // --- prose banks NOTHING --------------------------------------------------
  // Without the leading-slash requirement every Codex turn would record a fire
  // named after its first word: junk rows in the external-fires bucket and one
  // English word stored for no reason.
  console.log("CODEX LOG-EVENT (prose banks nothing):");
  const beforeProse = ledger.readEvents().length;
  const rp = logEvent(codexPayload("prose-secret.json"), ledger, "UserPromptSubmit", "codex");
  check("ordinary prose appends nothing", rp.appended === 0 && rp.skipped === 1, JSON.stringify(rp));
  check("no event named after the first word", !ledger.readEvents().some((e) => e.name === "please"));
  check("the ledger is unchanged", ledger.readEvents().length === beforeProse);

  // --- nothing but the token on disk ----------------------------------------
  console.log("CODEX LOG-EVENT (content never stored):");
  const usage = join(base, "usage");
  const stored = readdirSync(usage)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(usage, f), "utf8"))
    .join("");
  check("something was banked (the assertions below are not vacuous)", stored.includes('"deploy"'));
  for (const secret of ["AWS_SECRET", "hunter2", "password", "swordfish", "ghp_NEVERSTOREME", "SECRET-TAIL", "salary-notes"]) {
    check(`"${secret}" never reaches disk`, !stored.includes(secret));
  }
  // `kind":"prompt"` is ours; a `"prompt":` KEY would be the payload's own
  // free-text field, and a transcript path would hand a reader the rollout.
  check("no prompt field, transcript path or turn id is stored at all", !/"prompt":|transcript|turn_id|rollout|permission_mode/.test(stored));

  // --- provider selection ---------------------------------------------------
  // Both harnesses name an event UserPromptSubmit, so the event name alone
  // cannot pick the mapper: a Codex payload read by the Claude mapper must
  // produce nothing rather than a mis-provendered event.
  const before = ledger.readEvents().length;
  const rc = logEvent(codexPayload("prompt-secret.json"), ledger, "UserPromptSubmit");
  check("the claude mapper banks nothing from a codex payload", rc.appended === 0 && rc.skipped === 1, JSON.stringify(rc));
  const rk = logEvent(payload("skill.json"), ledger, "PostToolUse", "codex");
  check("the codex mapper banks nothing from a claude PostToolUse payload", rk.appended === 0 && rk.skipped === 1, JSON.stringify(rk));

  // --- malformed payloads never throw, never append -------------------------
  console.log("CODEX LOG-EVENT (malformed payloads):");
  const cases = [
    ["not JSON at all", "this is { not json"],
    ["empty stdin", ""],
    ["JSON scalar", "42"],
    ["JSON null", "null"],
    ["missing session_id", codexPayload("missing-session.json")],
    ["empty session_id", codexPayload("empty-session.json")],
    ["prompt is not a string", codexPayload("prompt-not-string.json")],
    ["pasted absolute path", codexPayload("pasted-path.json")],
    ["shell metacharacters glued to the token", codexPayload("metachars.json")],
    ["whitespace-only prompt", codexPayload("blank-prompt.json")],
    ["a bare slash", codexPayload("bare-slash.json")],
    ["an event we never installed", codexPayload("prompt-secret.json"), "PostToolUse"],
    ["a snake_case spelling of our own event", codexPayload("prompt-secret.json"), "user_prompt_submit"],
  ];
  for (const [name, stdin, event = "UserPromptSubmit"] of cases) {
    let r;
    let threw = false;
    try {
      r = logEvent(stdin, ledger, event, "codex");
    } catch {
      threw = true;
    }
    check(`${name} returns cleanly`, !threw && r.appended === 0 && r.skipped === 1, JSON.stringify(r));
  }
  check("malformed payloads appended nothing", ledger.readEvents().length === before);
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall hooks checks passed");
process.exit(failures ? 1 : 0);
