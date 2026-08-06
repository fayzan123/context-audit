#!/usr/bin/env node
// Unit corpus for the opt-in hooks channel (src/hooks.ts):
//   - install computes the settings.json edit, writes only on confirm
//   - install twice adds each entry once; uninstall restores byte-identically
//   - merge preserves pre-existing unrelated hooks and unknown keys
//   - corrupt settings.json refuses the edit, never clobbers
//   - log-event maps valid payloads, dedupes, and NEVER stores args/prompts
// Fixture homes are COPIED into mkdtemp dirs before editing and every ledger
// gets an injected base — the real $HOME is never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "hooks");
const { hooksInstall, hooksUninstall, logEvent } = await import(
  pathToFileURL(join(root, "dist", "hooks.js")).href
);
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

  const r2 = logEvent(payload("skill.json"), ledger, "PostToolUse");
  check("duplicate tool_use_id is skipped", r2.appended === 0 && r2.skipped === 1, JSON.stringify(r2));

  const r3 = logEvent(payload("agent.json"), ledger, "PostToolUse");
  const agent = ledger.readEvents({ kind: "agent" })[0];
  check(
    "agent payload maps subagent_type",
    r3.appended === 1 && agent?.name === "code-reviewer" && agent.id === "sess-1:toolu_def456"
  );

  const r4 = logEvent(payload("prompt.json"), ledger, "UserPromptExpansion");
  const cmd = ledger.readEvents({ kind: "command" })[0];
  check("prompt expansion appends a typed command", r4.appended === 1 && cmd?.channel === "typed");
  check("slash stripped, first token only", cmd.name === "impeccable");
  check("typed id follows sessionId:ts:name", /^sess-2:\d{4}-\d{2}-\d{2}T.*:impeccable$/.test(cmd.id), cmd.id);

  // --- no content ever stored ----------------------------------------------
  console.log("LOG-EVENT (content never stored):");
  const usage = join(base, "usage");
  const stored = readdirSync(usage)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(usage, f), "utf8"))
    .join("");
  check("no args, prompts, or tails reach disk", stored.length > 0 && !stored.includes("SECRET"));

  // --- malformed payloads never throw, never append -------------------------
  console.log("LOG-EVENT (malformed payloads):");
  const before = ledger.readEvents().length;
  const cases = [
    ["not JSON at all", "this is { not json"],
    ["empty stdin", ""],
    ["missing session_id", payload("missing-session.json")],
    ["tool outside the matchers", payload("wrong-tool.json")],
    ["shell metacharacters in the name", payload("args-in-name.json")],
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

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall hooks checks passed");
process.exit(failures ? 1 : 0);
