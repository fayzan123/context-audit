#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { discoverSkills, loadSkill } from "./skills.js";
import { contentFacts } from "./content.js";
import { securityScan } from "./security.js";
import { historyFacts } from "./history.js";
import { hooksInstall, hooksUninstall, logEvent } from "./hooks.js";
import { openLedger } from "./ledger.js";
import { runBackfill } from "./backfill.js";
import { buildLifetime, printAgent, printJson, printReport, withLifetime } from "./report.js";
import type { LifetimeBySource } from "./report.js";
import { ADAPTERS, SOURCE_IDS, auditSource, scanLedgerHome } from "./sources/index.js";
import { claudeAdapter } from "./sources/claude.js";
import type { SourceContext } from "./sources/index.js";
import type { AuditResult, MultiAuditResult, Skill, SourceAudit, SourceId } from "./types.js";

const HELP = `context-audit — what your skills cost every session, what actually
fires, what's dead weight, and what's dangerous. Facts, not judgment.

Audits the instruction files your AI coding tools execute — Claude Code
skills/agents/commands/CLAUDE.md, Codex prompts and AGENTS.md, Cursor rules,
and the cross-tool AGENTS.md standard. One run, every tool on the machine.

Usage:
  context-audit                  detect every supported tool (via $HOME and the
                                 current directory) and audit all of them
  context-audit [dir]            audit one claude-format skills directory
  context-audit scan <path>      pre-install scan of a single skill (dir or .md
                                 file); content + security only, no history
  context-audit ui [dir]         open the audit as a local dashboard — inventory,
                                 cost, usage and security in one page, with safe
                                 enable/disable for Claude user skills. Localhost
                                 only; --no-open prints the URL without launching
                                 a browser
  context-audit install-skill    install the companion skill into
                                 ~/.claude/skills/context-audit — after that,
                                 asking your agent "why isn't my skill firing?"
                                 or "audit my skills" runs this tool for you
  context-audit hooks install    record fires in real time: adds Claude Code
                                 hooks that pipe each skill/command/agent event
                                 to this tool's local usage ledger. Prints the
                                 exact settings.json edit and asks before
                                 writing (--yes applies without the prompt)
  context-audit hooks uninstall  remove exactly what install added (same
                                 diff-and-confirm flow)
  context-audit backfill         import typed /commands from
                                 ~/.claude/history.jsonl into the usage ledger
                                 — it outlives the transcript purge by months.
                                 Idempotent; Claude Code built-ins are dropped
                                 unless --include-builtins
  context-audit log-event        hook target: reads one payload from stdin,
                                 records it, always exits 0. Installed by
                                 \`hooks install\`, not for manual use

Options:
  --source <ids>        audit only these sources (comma-separated:
                        ${SOURCE_IDS.join(", ")})
  --strict              also gate on capability grants (allowed-tools: Bash and
                        friends). Always on for \`scan\` — before you install
                        something, what it is allowed to do is the whole question.
  --agent               compact JSON for AI agents (flags in full, noise aggregated)
  --json                full machine-readable output
  --no-history          skip local transcript scans
  --transcripts <dir>   Claude transcript location (default: ~/.claude/projects)
  --yes                 hooks install/uninstall: apply the printed edit without
                        the interactive confirm
  --include-builtins    backfill: also import built-in commands (/usage, …)
  --home <dir>          treat <dir> as the user home (default: your real home)
  -h, --help            this help

Exit codes: 0 = no security flags · 1 = at least one security flag · 2 = usage error

Everything runs locally. Nothing leaves the machine.`;

interface Args {
  command: "audit" | "scan" | "ui" | "install-skill" | "hooks" | "log-event" | "backfill";
  hooksAction?: "install" | "uninstall";
  target?: string;
  output: "report" | "json" | "agent";
  history: boolean;
  transcripts?: string;
  strict: boolean;
  sources?: SourceId[];
  open: boolean;
  yes: boolean;
  includeBuiltins: boolean;
  home?: string;
  claudeHook?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "audit",
    output: "report",
    history: true,
    strict: false,
    open: true,
    yes: false,
    includeBuiltins: false,
  };
  // log-event is invoked by harness hooks, not humans: a parse failure here
  // would surface as an error inside someone's session, so it never reaches
  // fail() — a malformed invocation exits 0 doing nothing.
  if (argv[0] === "log-event") {
    args.command = "log-event";
    const at = argv.indexOf("--claude-hook");
    if (at !== -1) args.claudeHook = argv[at + 1];
    return args;
  }
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "--json") args.output = "json";
    else if (a === "--agent") args.output = "agent";
    else if (a === "--no-history") args.history = false;
    else if (a === "--no-open") args.open = false;
    else if (a === "--strict") args.strict = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--include-builtins") args.includeBuiltins = true;
    else if (a === "--home") {
      const v = argv[++i];
      if (!v) fail("--home requires a directory");
      args.home = resolve(v);
    } else if (a === "--claude-hook") {
      const v = argv[++i];
      if (!v) fail("--claude-hook requires an event name");
      args.claudeHook = v;
    } else if (a === "--transcripts") {
      const v = argv[++i];
      if (!v) fail("--transcripts requires a directory");
      args.transcripts = resolve(v);
    } else if (a === "--source") {
      const v = argv[++i];
      if (!v) fail(`--source requires a comma-separated list of: ${SOURCE_IDS.join(", ")}`);
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      for (const id of ids) {
        if (!SOURCE_IDS.includes(id as SourceId)) {
          fail(`unknown source: ${id} (known: ${SOURCE_IDS.join(", ")})`);
        }
      }
      args.sources = ids as SourceId[];
    } else if (a.startsWith("-")) fail(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional[0] === "scan") {
    args.command = "scan";
    args.target = positional[1];
    if (!args.target) fail("scan requires a path to a skill directory or .md file");
  } else if (positional[0] === "ui") {
    args.command = "ui";
    args.target = positional[1];
  } else if (positional[0] === "install-skill") {
    args.command = "install-skill";
  } else if (positional[0] === "hooks") {
    args.command = "hooks";
    const action = positional[1];
    if (action !== "install" && action !== "uninstall") fail("hooks requires an action: install or uninstall");
    args.hooksAction = action;
  } else if (positional[0] === "backfill") {
    args.command = "backfill";
  } else if (positional[0] === "log-event") {
    // Reached only when options preceded the subcommand; the argv[0] fast
    // path above covers the command hooks actually install.
    args.command = "log-event";
  } else {
    args.target = positional[0];
  }
  return args;
}

function fail(msg: string): never {
  console.error(`context-audit: ${msg}`);
  console.error(`run with --help for usage`);
  process.exit(2);
}

const hasFlags = (sources: SourceAudit[]): boolean =>
  sources.some((s) => s.security.some((f) => f.level === "flag"));

/**
 * Copy the bundled companion skill into the user's skills directory. The skill
 * is the surface most users actually meet — they ask their agent, not a
 * terminal — so installing it has to be one command, not "clone the repo and
 * copy a file". Idempotent: same content means no write and says so.
 */
function installSkill(home: string): void {
  let content: string;
  try {
    content = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  } catch {
    return fail("bundled companion skill missing — reinstall context-audit (npm i -g context-audit)");
  }
  const dir = join(home, ".claude", "skills", "context-audit");
  const dest = join(dir, "SKILL.md");
  const existing = existsSync(dest) ? readFileSync(dest, "utf8") : undefined;
  if (existing === content) {
    console.log(`already installed and up to date: ${dest}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(dest, content);
  console.log(`${existing === undefined ? "installed" : "updated"}: ${dest}`);
  console.log(`
Your agent picks this up in new sessions. Ask in plain language:
  "why isn't my skill firing?" · "audit my skills" · "what is my context costing?"
The skill runs the audit, verifies findings before alarming you, and starts
the dashboard (context-audit ui) when you want to browse and clean up.`);
}

const day = (iso?: string): string => (iso ? iso.slice(0, 10) : "unknown");

/**
 * Hook target. This process runs inside someone's Claude Code session, and a
 * broken hook must never break it — every path, including an unwritable
 * ledger or absent stdin, exits 0 in silence.
 */
async function runLogEvent(ctx: SourceContext, eventName?: string): Promise<void> {
  try {
    if (eventName && !process.stdin.isTTY) {
      let stdin = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) stdin += chunk;
      logEvent(stdin, openLedger(scanLedgerHome(ctx)), eventName);
    }
  } catch {}
  process.exitCode = 0;
}

/**
 * Diff-and-confirm flow for the opt-in hooks channel. The edit is always
 * printed before anything is written; writing takes an explicit --yes or an
 * interactive y/N on a TTY — never silence.
 */
async function runHooks(ctx: SourceContext, action: "install" | "uninstall", yes: boolean): Promise<void> {
  const compute = action === "install" ? hooksInstall : hooksUninstall;
  const dry = compute(ctx.home);
  if (dry.error) {
    console.error(`context-audit: ${dry.error}`);
    process.exitCode = 2;
    return;
  }
  if (!dry.changed) {
    console.log(
      action === "install"
        ? `nothing to add — the hooks are already installed in ${dry.path}`
        : `nothing to remove — no context-audit hooks in ${dry.path}`
    );
    return;
  }
  console.log(`hooks ${action} — the exact edit to ${dry.path}:\n`);
  console.log(dry.diff);
  let confirmed = yes;
  if (!confirmed && process.stdin.isTTY && process.stdout.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("apply this edit? [y/N] ")).trim().toLowerCase();
    rl.close();
    confirmed = answer === "y" || answer === "yes";
  }
  if (!confirmed) {
    console.log(`not written. apply it with: context-audit hooks ${action} --yes`);
    return;
  }
  // Recomputed from disk at write time: a settings.json that changed since
  // the diff was printed is re-read rather than clobbered from stale memory.
  const wet = compute(ctx.home, { confirm: true });
  if (wet.error) {
    console.error(`context-audit: ${wet.error}`);
    process.exitCode = 2;
    return;
  }
  console.log(wet.written ? `written: ${wet.path}` : `no write needed — ${wet.path} already matched`);
  if (action === "install") {
    console.log(`Skill, Agent/Task and typed-command events now stream to the usage ledger`);
    console.log(`as they happen (new sessions pick the hooks up). Remove them anytime:`);
    console.log(`  context-audit hooks uninstall`);
  }
}

/** Import the typed channel from ~/.claude/history.jsonl into the ledger. */
async function runBackfillImport(ctx: SourceContext, includeBuiltins: boolean): Promise<void> {
  const historyPath = join(ctx.home, ".claude", "history.jsonl");
  if (!existsSync(historyPath)) {
    console.log(`nothing to import — ${historyPath} does not exist`);
    return;
  }
  const ledger = openLedger(scanLedgerHome(ctx));
  // Ingest the current transcript window first: the importer skips sessions
  // that already contributed transcript-derived events, and that exclusion
  // set only exists once ingestion has run.
  const assets = claudeAdapter.discover(ctx);
  if (claudeAdapter.usage) {
    const h = await claudeAdapter.usage(ctx, assets);
    if (h.events && h.events.length > 0) ledger.appendEvents(h.events);
  }
  const skills = new Set<string>();
  const commands = new Set<string>();
  for (const a of assets) {
    if ((a.kind ?? "skill") === "skill") skills.add(a.dirName);
    else if (a.kind === "command") commands.add(a.dirName);
  }
  const r = runBackfill(ctx.home, ledger, { skills, commands }, { includeBuiltins });

  console.log(`backfill — ${historyPath}`);
  console.log(`  imported: ${r.imported} typed-command event(s)`);
  console.log(
    `  dropped: ${r.droppedPollerSessions} all-built-in session(s), ${r.droppedBuiltins} built-in command(s)` +
      (r.droppedBuiltins > 0 && !includeBuiltins ? " — import them with --include-builtins" : "")
  );
  if (r.unresolved.length > 0) {
    console.log(`  unresolved (no installed skill/command by that name, imported anyway): ${r.unresolved.join(", ")}`);
  }
  // Horizon labeling: the backfilled horizon extends the TYPED channel only,
  // so the two dates are stated apart and never conflated.
  const events = ledger.readEvents();
  const typedSince = events.find((e) => e.backfill === true)?.ts;
  const autoSince = events.find((e) => e.channel === "auto")?.ts;
  if (typedSince) {
    console.log(
      `  typed-channel history extends to ${day(typedSince)} (backfilled); ` +
        (autoSince
          ? `model-invoked history begins ${day(autoSince)}`
          : `no model-invoked events recorded yet (tracking since ${day(ledger.meta().trackedSince)})`)
    );
  } else {
    console.log(`  no backfilled events in the ledger — nothing in ${historyPath} qualified`);
  }
}

function toSourceAudit(source: SourceId, skills: Skill[], strict: boolean): SourceAudit {
  return {
    source,
    assets: skills.map((s) => ({ name: s.dirName, kind: s.kind ?? "skill", path: s.dir })),
    content: contentFacts(skills),
    security: securityScan(skills, strict),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx: SourceContext = { home: args.home ?? homedir(), cwd: process.cwd(), transcripts: args.transcripts };

  if (args.command === "log-event") {
    await runLogEvent(ctx, args.claudeHook);
    return;
  }

  if (args.command === "hooks") {
    await runHooks(ctx, args.hooksAction!, args.yes);
    return;
  }

  if (args.command === "backfill") {
    await runBackfillImport(ctx, args.includeBuiltins);
    return;
  }

  if (args.command === "install-skill") {
    installSkill(ctx.home);
    return;
  }

  if (args.command === "ui") {
    // Deferred import: the dashboard pulls in the http server and the built
    // page; the plain CLI paths should not pay for either.
    const { startUiServer } = await import("./ui/server.js");
    const { openUrl } = await import("./ui/open.js");
    if (args.target) {
      const dir = resolve(args.target);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`skills directory not found: ${dir}`);
    }
    const { url } = await startUiServer(ctx, {
      history: args.history,
      dir: args.target ? resolve(args.target) : undefined,
      sources: args.sources,
    });
    console.log(`context-audit ui — dashboard running (localhost only, this session's URL carries its key)`);
    console.log(`\n  ${url}\n`);
    console.log(`Ctrl-C stops the server. Nothing leaves the machine.`);
    if (args.open) openUrl(url);
    return; // the server keeps the process alive
  }

  if (args.command === "scan") {
    const target = resolve(args.target!);
    if (!existsSync(target)) fail(`not found: ${target}`);
    const skills = [loadSkill(target)];
    // Pre-install: capability grants are the decision, so never relax them.
    const legacy: AuditResult = {
      dir: target,
      content: contentFacts(skills),
      security: securityScan(skills, true),
    };
    // The scan JSON shape is the tool's oldest contract; it stays byte-stable.
    if (args.output === "json") printJson(legacy);
    else print(args.output, { sources: [toSourceAudit("custom", skills, true)] });
    // exitCode, not exit(): exit() truncates piped stdout before it flushes.
    process.exitCode = legacy.security.some((f) => f.level === "flag") ? 1 : 0;
    return;
  }

  let sources: SourceAudit[];
  if (args.target) {
    // Explicit directory: the original single-directory audit, now one source.
    const dir = resolve(args.target);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`skills directory not found: ${dir}`);
    const skills = discoverSkills(dir).map((s) => ({ ...s, source: "custom" as const }));
    const audit = toSourceAudit("custom", skills, args.strict);
    if (args.history) {
      audit.history = await historyFacts(
        args.transcripts ?? join(ctx.home, ".claude", "projects"),
        skills
      );
    }
    sources = [audit];
  } else {
    const wanted = ADAPTERS.filter((a) => !args.sources || args.sources.includes(a.id));
    const detected = wanted.filter((a) => a.detect(ctx));
    if (detected.length === 0) {
      fail(
        args.sources
          ? `none of the requested sources are present on this machine`
          : `no supported agent tools detected (looked for ~/.claude, ~/.codex, .cursor/rules, .cursorrules, AGENTS.md)`
      );
    }
    const audits = await Promise.all(
      detected.map((a) => auditSource(a, ctx, { history: args.history, strict: args.strict }))
    );
    // A tool whose directory exists but holds no instruction assets has nothing
    // to say; keeping the empty section would just pad the report.
    sources = audits.filter((s) => s.assets.length > 0);
    if (sources.length === 0) fail(`detected tools but found no instruction assets to audit`);
  }

  const result: MultiAuditResult = { sources };
  const lifetime = args.history ? ledgerLifetime(ctx, sources) : undefined;
  print(args.output, result, lifetime);
  process.exitCode = hasFlags(sources) ? 1 : 0;
}

/**
 * The durable-ledger pass for the CLI: bank custom-dir events (adapter paths
 * bank inside auditSource), read the accumulated lifetime back, and leave one
 * snapshot line for this run. An unavailable ledger degrades to the
 * window-only report the audit always had — with a caveat, never a crash.
 */
function ledgerLifetime(ctx: SourceContext, sources: SourceAudit[]): LifetimeBySource | undefined {
  try {
    const ledger = openLedger(scanLedgerHome(ctx));
    for (const s of sources) {
      const events = s.history?.events ?? [];
      if (s.source === "custom" && events.length > 0) ledger.appendEvents(events);
    }
    const lifetime = buildLifetime(sources, ledger.readEvents(), ledger.meta().trackedSince);
    const byProvider: Record<string, number> = {};
    let items = 0;
    let injectedChars = 0;
    for (const s of sources) {
      byProvider[s.source] = (byProvider[s.source] ?? 0) + s.assets.length;
      items += s.assets.length;
      injectedChars += s.content.alwaysInjectedChars;
    }
    try {
      // One snapshot per run, mirroring buildUiPayload's dashboard-side line.
      // The CLI discovers enabled assets only, so enabled = items here.
      ledger.appendSnapshot({ ts: new Date().toISOString(), items, enabled: items, injectedChars, byProvider });
    } catch {
      // Snapshots power deltas, not this report; a failed append changes nothing here.
    }
    return lifetime;
  } catch (err) {
    const why = String((err as Error)?.message ?? err).slice(0, 120);
    for (const s of sources) {
      if (!s.history) continue;
      // auditSource may have already said this while banking; one caveat is enough.
      if (s.caveats?.some((c) => c.startsWith("usage ledger unavailable"))) continue;
      (s.caveats ??= []).push(
        `usage ledger unavailable (${why}) — lifetime figures omitted; usage figures reflect the current transcript window only`
      );
    }
    return undefined;
  }
}

function print(output: Args["output"], result: MultiAuditResult, lifetime?: LifetimeBySource): void {
  if (output === "json") printJson(withLifetime(result, lifetime));
  else if (output === "agent") printAgent(result, lifetime);
  else printReport(result, lifetime);
}

main().catch((err) => {
  // Filesystem errors quote the offending path verbatim, and those paths come
  // from directory names someone else chose — control characters in one would
  // reach the terminal as escape sequences.
  const msg = String(err?.message ?? err)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .slice(0, 500);
  console.error(`context-audit: ${msg}`);
  process.exit(2);
});
