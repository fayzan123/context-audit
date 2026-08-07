import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { LISTING_BUDGET_CHARS, injectedChars, listingBudget, listingChars } from "../content.js";
import { bodyHash, createHealthCache, freshnessOf, nearMissMap, referencedBy, resolveRefs } from "../health.js";
import { historyFacts } from "../history.js";
import { openLedger, type Ledger, type LedgerSnapshot } from "../ledger.js";
import { resolveProvenance } from "../provenance.js";
import { securityScan } from "../security.js";
import { discoverSkills, isSkillMd, parseFrontmatter } from "../skills.js";
import { ADAPTERS, scanLedgerHome, type AuditContext } from "../sources/index.js";
import { codexAdapter } from "../sources/codex.js";
import { claudeAdapter } from "../sources/claude.js";
import { cursorAdapter } from "../sources/cursor.js";
import { cursorStorePath } from "../sources/cursordb.js";
import { BUILTIN_COMMANDS } from "../types.js";
import type {
  AssetKind,
  LedgerEvent,
  SecurityFinding,
  Skill,
  SkillUsage,
  SourceId,
  UiBudgetCut,
  UiDelta,
  UiFireEvent,
  UiFires,
  UiGrowth,
  UiItem,
  UiPayload,
  UiPluginMeta,
  UiPortfolio,
  UiSuperseded,
} from "../types.js";
import {
  discoverPluginAssets,
  latestKnownVersion,
  resolveActivePlugins,
  supersededVersions,
  updateRelevance,
  type PluginInstall,
} from "../plugins.js";

/** Whole days, for every "N days ago" figure in the payload. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the owned-vs-fired series may reach. A ledger line stamped
 * 1970 (a hand-edited file, a harness with a broken clock) passes the durable
 * boundary — its ts parses — and would stretch a two-year chart into a
 * 2,900-point one. The series is bounded from the RECENT end, so the cap
 * removes prehistory rather than the weeks the reader came for — and that end
 * is the SCAN's own week, never the newest key, or one future-dated line would
 * push the window past every real week (see the growth block).
 */
const MAX_GROWTH_WEEKS = 104;

/**
 * 2000-01-01T00:00:00Z — the same floor provenance.ts and health.ts apply. A
 * filesystem that records no stamp reports epoch 0, and "disabled 20,000 days
 * ago" would render a missing datum as a fact.
 */
const MIN_VALID_MS = 946684800000;

export interface UiBuildOptions {
  history: boolean;
  /** Explicit-directory mode: audit one claude-format skills directory. */
  dir?: string;
  sources?: SourceId[];
  /**
   * Server-side hand-off: called once per build with the scan's open ledger
   * (undefined when unavailable), so request handlers reuse the parsed
   * instance instead of re-reading the whole store per click. Never part of
   * the payload — the browser gets JSON only.
   */
  onLedger?: (ledger: Ledger | undefined) => void;
}

/**
 * Stable item identity: hash of source + kind + path. Every mutating endpoint
 * resolves one of these back to a path from the server's own inventory —
 * client-supplied paths are never accepted, so this is the only vocabulary
 * the browser has for naming files.
 */
export function itemId(source: string, kind: string, path: string): string {
  return createHash("sha256").update(`${source}\0${kind}\0${path}`).digest("hex").slice(0, 16);
}

/**
 * Browser-facing event identity: a digest of the durable ledger id. Raw ids
 * embed session ids — and load-event ids embed absolute directories — so the
 * verbatim id in a payload would leak exactly what the projection's other
 * fields redact. The server resolves a digest back to its event from its own
 * ledger, the same trust model as item ids.
 */
export function eventDigest(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

/** One discovered asset plus everything the payload needs that Skill lacks. */
interface Row {
  skill: Skill;
  source: SourceId;
  enabled: boolean;
  togglable: boolean;
  readOnlyReason?: string;
  plugin?: UiPluginMeta;
  /**
   * The resolved install this row's files came from — held beside the
   * browser-facing `plugin` metadata because the update comparison needs the
   * install ROOT, which is a filesystem path and therefore never leaves here.
   */
  install?: PluginInstall;
  /**
   * Fire tracking exists for this row's kind (claude skills/commands/agents,
   * codex prompts, and cursor rules once the store has actually been read).
   */
  tracked: boolean;
  /** The other copy's path when this name exists both enabled and disabled. */
  twinPath?: string;
}

const V1_READONLY = {
  plugin: "Plugin-managed — read-only here; enable or disable the plugin from Claude Code",
  project: "Project-scoped — the disable convention covers user-scoped assets only",
  kind: "No disable convention for this kind: it is not resolved from a directory this tool can move it out of",
  vendor: "Read-only — no invented disable conventions for other vendors in v1",
  custom: "Explicit-directory audits are read-only",
} as const;

function toFires(u: SkillUsage): UiFires {
  return {
    invocations: u.invocations,
    sessions: u.sessions,
    firstFired: u.firstFired,
    lastFired: u.lastFired,
    interruptedAfter: u.interruptedAfter,
  };
}

/**
 * The entry file's text: SKILL.md where there is one, otherwise the single
 * file a one-file asset is. Shared by the frontmatter re-read and the
 * reference check so both speak about the SAME file — a refs section computed
 * from a different file than the drawer shows would cite line numbers the
 * reader cannot find.
 */
function entryText(skill: Skill): string | undefined {
  return (
    skill.files.find((f) => isSkillMd(f.relPath))?.content ??
    (skill.files.length === 1 ? skill.files[0]?.content : undefined)
  );
}

/** Frontmatter of the entry file, re-read for the drawer. */
function entryFrontmatter(skill: Skill): Record<string, string> | undefined {
  const entry = entryText(skill);
  if (!entry) return undefined;
  const { fm } = parseFrontmatter(entry);
  return Object.keys(fm).length > 0 ? fm : undefined;
}

/**
 * Best available evidence for WHEN a row was disabled, and only where such
 * evidence exists.
 *
 * Moving a skill into `skills-disabled/` is a rename: it leaves the
 * directory's mtime alone but does bump its ctime, so ctime is the closest
 * thing on disk to a disable date. It is an upper bound — anything else that
 * touches the directory's metadata moves it too — and the UI must label it as
 * such. A plugin disabled through settings.json leaves no per-plugin evidence
 * at all: those rows get NO date rather than settings.json's mtime, which
 * dates the last edit to any setting on the machine.
 */
function disabledAt(row: Row): string | undefined {
  if (row.plugin) return undefined;
  try {
    const ms = statSync(row.skill.dir).ctimeMs;
    return Number.isFinite(ms) && ms > MIN_VALID_MS ? new Date(ms).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The id of the subagent transcript a LAUNCH event spawned — undefined
 * whenever this event cannot prove it holds one.
 *
 * `LedgerEvent.agent` carries two different facts. For a launch made from the
 * main thread, history.ts recovers the SPAWNED agent's id from the result
 * line's `toolUseResult.agentId` and stamps `{ id, type: <the dispatched
 * subagent_type> }`. For any line read out of `subagents/agent-<id>.jsonl` it
 * stamps the CONTAINING sidechain's id instead — and deliberately refuses to
 * overwrite that, because on every other kind of event the field means "this
 * fire happened inside sidechain X". Pricing the second kind charges this row
 * the PARENT run's whole transcript, and prices that same transcript a second
 * time on the parent's own row.
 *
 * Two signatures separate them, and a launch matching neither is left
 * unpriced: the drawer already states "priced N of M recorded launches", so an
 * unattributable run costs a denominator — while a real token count printed on
 * the wrong agent's row cannot be un-read.
 */
function spawnedAgentId(e: LedgerEvent): string | undefined {
  const agent = e.agent;
  if (!agent?.id) return undefined;
  // Read out of that very agent's own transcript: the stamp is the container's,
  // so this is a launch made from INSIDE a sidechain.
  const own = /(?:^|[\\/])agent-(.+)\.jsonl$/.exec(e.src?.file ?? "");
  if (own && own[1] === agent.id) return undefined;
  // The result-line fixup is the only writer that sets `type` to the launched
  // subagent_type; a build-time stamp carries the containing agent's type, or
  // an empty string where the line names none.
  return agent.type === e.name ? agent.id : undefined;
}

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Findings for one row, scanned alone.
 *
 * Every check in the engine derives from a single skill — the scan loops
 * skills independently and `alsoInFiles` groups within one — so scanning row
 * by row is the same analysis, and it is the only way to attribute findings
 * exactly. Handing the whole set to one call and sorting the results out
 * afterwards cannot work: findings identify their skill by DISPATCH NAME, and
 * two rows sharing a name is a real state on a real machine (the same skill
 * present in both `skills/` and `skills-disabled/` — which is exactly the
 * setup this was found on). The enabled copy then rendered clean while its
 * flags were filed against the disabled twin.
 */
function findingsFor(row: Row): SecurityFinding[] {
  // Installed-audit semantics (relaxed), same as the CLI's default.
  return securityScan([row.skill], false);
}

export async function buildUiPayload(ctx: AuditContext, opts: UiBuildOptions): Promise<UiPayload> {
  // ONE clock for the whole build. Every "N days ago" below and the
  // generatedAt stamp the page renders them beside are taken from this
  // instant: an age measured against a different moment than the timestamp it
  // sits next to is how a dashboard contradicts itself inside one screen —
  // and a scan that spans midnight would otherwise disagree with its own
  // header by a day.
  const scanNow = Date.now();
  const scanNowIso = new Date(scanNow).toISOString();
  /** Whole days from an ISO stamp to this scan's clock; undefined when unparseable. */
  const daysSince = (ts: string): number | undefined => {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return undefined;
    // A stamp in the future is clock skew (a file written by another machine),
    // not a negative age — it reads as "today" rather than "edited -3d ago".
    return Math.max(0, Math.floor((scanNow - ms) / DAY_MS));
  };
  const rows: Row[] = [];
  let pluginResolution: UiPayload["pluginResolution"];
  /**
   * The resolved installs behind this scan's plugin rows, kept at build scope
   * because two payload-level facts need them after the row loop is done: the
   * superseded-versions walk and the since-last-scan update derivation. Both
   * must describe the SAME resolution the rows were built from — resolving the
   * plugin set twice is how one surface reports a version the other does not.
   */
  let pluginInstalls: PluginInstall[] = [];
  let superseded: UiSuperseded[] | undefined;
  /**
   * Payload-level qualifiers — a provider whose local store could not be read,
   * a schema that changed shape. Collected here because they belong to no
   * single row; degraded is always stated, never silent.
   */
  const caveats: string[] = [];

  if (opts.dir) {
    const dir = resolve(opts.dir);
    for (const s of discoverSkills(dir)) {
      rows.push({
        skill: { ...s, source: "custom" },
        source: "custom",
        enabled: true,
        togglable: false,
        readOnlyReason: V1_READONLY.custom,
        // Same as the CLI's explicit-directory audit: claude-format skills in
        // any directory dispatch by name, so the transcripts can speak to them.
        tracked: true,
      });
    }
  } else {
    const wanted = ADAPTERS.filter((a) => !opts.sources || opts.sources.includes(a.id));
    for (const adapter of wanted.filter((a) => a.detect(ctx))) {
      for (const skill of adapter.discover(ctx)) {
        // The claude adapter discovers plugin assets too, so the CLI's figures
        // cover what Claude Code really loads. The dashboard needs each
        // install's version and marketplace to group and update them, so it
        // discovers plugins itself below — skip the adapter's copies here or
        // every plugin asset lands in the inventory twice.
        if (skill.fromPlugin) continue;
        const kind = skill.kind ?? "skill";
        // A direct child of a user root, matching what toggle.ts will
        // actually accept. `startsWith(root + "/")` was both laxer (nested
        // paths) and, on Windows, never true at all — join() produces
        // backslashes, so every user skill silently lost its toggle.
        //
        // Agents are here too. They were held back while it looked like
        // moving one would mean inventing a disable convention; `skills-
        // disabled` turned out to be no convention either, just a sibling
        // Claude Code does not read, and `agents-disabled` is the same
        // sibling of `.claude/agents/*.md`. On a machine that is two thirds
        // never-launched agents, measuring them while refusing to move them
        // made the tool a report rather than a fix.
        const userRoot: Record<string, string> = {
          skill: join(ctx.home, ".claude", "skills"),
          agent: join(ctx.home, ".claude", "agents"),
        };
        // An agent is a single FILE, so its parent is the file's directory,
        // not the asset directory a skill has.
        const parent = dirname(kind === "agent" ? skill.files[0]?.absPath ?? skill.dir : skill.dir);
        // The disabled side is discovered too, and stays a first-class row —
        // grayed, re-enableable, history intact, and out of the per-session
        // total, because the header reports what the setup actually costs.
        // Skills get this a few lines below, from their own walk; agents come
        // through this loop because the adapter discovers both sides at once.
        const offRoot = kind === "agent" ? join(ctx.home, ".claude", "agents-disabled") : undefined;
        const isOff = offRoot !== undefined && parent === offRoot;
        const isUserSkill =
          adapter.id === "claude" && userRoot[kind] !== undefined && (parent === userRoot[kind] || isOff);
        rows.push({
          skill,
          source: adapter.id,
          enabled: !isOff,
          togglable: isUserSkill,
          readOnlyReason: isUserSkill
            ? undefined
            : adapter.id !== "claude"
              ? V1_READONLY.vendor
              : kind === "skill"
                ? V1_READONLY.project
                : V1_READONLY.kind,
          // Agents are dispatch-tracked: `Agent`/`Task` tool_use blocks name
          // the subagent_type they launched, so the ledger has held their
          // fires since S1 and the only thing missing was a row to join them
          // to. Their WINDOW figures come from those events rather than from
          // the usage table (see the item join — history.ts deliberately keeps
          // agents out of that aggregation).
          tracked:
            (adapter.id === "claude" && (kind === "skill" || kind === "command" || kind === "agent")) ||
            (adapter.id === "codex" && kind === "prompt"),
        });
      }

      if (adapter.id === "claude") {
        // Disabled skills are first-class rows: grayed, re-enableable, fire
        // history intact — and excluded from the injected-token header total,
        // because the header reports what the setup actually costs.
        const disabledRoot = join(ctx.home, ".claude", "skills-disabled");
        if (existsSync(disabledRoot) && statSync(disabledRoot).isDirectory()) {
          for (const s of discoverSkills(disabledRoot)) {
            rows.push({
              skill: { ...s, source: "claude", kind: "skill", injection: "description" },
              source: "claude",
              enabled: false,
              togglable: true,
              tracked: true,
            });
          }
        }

        const { installs, resolution } = resolveActivePlugins(ctx.home);
        if (installs.length > 0 || existsSync(join(ctx.home, ".claude", "plugins"))) {
          pluginResolution = resolution;
        }
        pluginInstalls = installs;
        // Old version directories the cache still holds. Resolved here, once,
        // against the install list the rows are about to be built from: the
        // walk needs to know which version is ACTIVE to call the others
        // superseded, and a second resolution could disagree with the first.
        // Paths are reported and never touched — this tool measures.
        const stale = supersededVersions(ctx.home, installs);
        if (stale.length > 0) superseded = stale;
        for (const install of installs) {
          const latest = latestKnownVersion(ctx.home, install);
          for (const { skill } of discoverPluginAssets(install)) {
            rows.push({
              skill,
              source: "claude",
              enabled: install.enabled,
              togglable: false,
              readOnlyReason: V1_READONLY.plugin,
              plugin: {
                name: install.name,
                version: install.version,
                marketplace: install.marketplace,
                latest,
                // `lastUpdated` is "the current version has been in place
                // since", NOT a second install date — it is the boundary the
                // fires-either-side comparison splits on, and reading it as an
                // install date would move that boundary by months.
                installedAt: install.installedAt,
                lastUpdated: install.lastUpdated,
              },
              install,
              tracked: skill.kind === "skill" || skill.kind === "command" || skill.kind === "agent",
            });
          }
        }
      }
    }
  }

  // The same dispatch name on both sides of the toggle — a copy in skills/ AND
  // one in skills-disabled/ — is a real machine state. Both rows stay (their
  // contents, and therefore their findings, can differ), but they are linked:
  // the disabled copy is SHADOWED — it never dispatches, its toggle would
  // collide, and the name's fire history belongs to the enabled copy — and
  // rendering the two as unrelated rows with identical fire counts read as a
  // double-count bug on the machine this was found on.
  const enabledUserSkills = new Map(
    rows
      .filter((r) => r.source === "claude" && (r.skill.kind ?? "skill") === "skill" && r.enabled && r.togglable)
      .map((r) => [r.skill.dirName, r])
  );
  for (const row of rows) {
    if (row.enabled || row.source !== "claude" || (row.skill.kind ?? "skill") !== "skill" || !row.togglable) continue;
    const twin = enabledUserSkills.get(row.skill.dirName);
    if (twin) {
      row.twinPath = twin.skill.dir;
      twin.twinPath = row.skill.dir;
    }
  }

  const findingsByRow = new Map<Row, SecurityFinding[]>();
  for (const row of rows) findingsByRow.set(row, findingsFor(row));
  const sources = [...new Set(rows.map((r) => r.source))];

  // Fire history. Claude transcripts plus Codex rollouts — the two tools that
  // keep readable local history. Disabled and plugin dispatchables are
  // included: the transcript records the dispatch name, so their history
  // survives being disabled.
  //
  // Keyed by SOURCE + KIND + name — the ledger's join key. One flat name map
  // let a Codex prompt hand its invocation count to an identically named
  // Claude command (`review` is a plausible name in both), which is a
  // fabricated number in a tool whose entire claim is that it does not
  // fabricate numbers.
  const usageByKey = new Map<string, UiFires>();
  const rawEvents: LedgerEvent[] = [];
  const joinKey = (provider: string, kind: string, name: string): string =>
    `${provider}\u0000${kind}\u0000${name}`;
  // The dispatch token's kind(s) per the CURRENT inventory. Ledger events are
  // re-keyed through this at join time (below): hook writers hard-code a
  // provisional kind, and older banked events carry last-wins guesses — the
  // inventory, not the writer, decides which row a claude dispatch name
  // belongs to.
  const claudeKinds = new Map<string, Set<AssetKind>>();
  for (const r of rows) {
    if (!(r.source === "claude" || r.source === "custom") || !r.tracked) continue;
    const k = r.skill.kind ?? "skill";
    const set = claudeKinds.get(r.skill.dirName);
    if (set) set.add(k);
    else claudeKinds.set(r.skill.dirName, new Set([k]));
  }

  let history: UiPayload["history"];
  // Per-provider window starts, captured BEFORE the merge below: the
  // dead-weight age gate and the load in-window count must compare against
  // the window of the provider that produced the evidence, and the merged
  // minimum is not that.
  let claudeWindowStart: string | undefined;
  let codexWindowStart: string | undefined;
  // Cursor's own window, deliberately NOT folded into the merged one below:
  // the conversation store reaches back to 2025 while claude transcripts reach
  // back weeks, and rebasing the merged window on it would turn an honest
  // "none in 42d" into a claim about eleven months nobody observed.
  let cursorWindowStart: string | undefined;
  /**
   * The window one row's figures are counted against — THAT provider's, never
   * the merged one (invariant 4). A lookup rather than a growing ternary: a
   * missing branch here is silent, and the one that was missing (cursor, which
   * fell through to Claude's horizon) is how a fifteen-month store came to be
   * counted and captioned as "2 in 43d".
   *
   * Read lazily — every call site runs after the history block below has
   * assigned these.
   */
  const windowStartFor = (source: SourceId): string | undefined => {
    switch (source) {
      case "codex":
        return codexWindowStart;
      case "cursor":
        return cursorWindowStart;
      // An AGENTS.md's fires are LOADS, recorded by the harness that read the
      // file, and only codex rollouts record one.
      case "agents-md":
        return codexWindowStart;
      // claude, and `custom` (an explicit-directory audit of claude-format
      // assets) — both dispatch into ~/.claude/projects transcripts.
      default:
        return claudeWindowStart;
    }
  };
  // The same per-provider windows, kept for the PAYLOAD rather than for the
  // gates above: a cross-provider comparison captioned with one date would
  // claim a retention horizon two of the three providers never had.
  const providerWindows: NonNullable<UiPayload["providerWindows"]> = {};
  const noteWindow = (source: SourceId, start?: string, end?: string): void => {
    if (start === undefined && end === undefined) return;
    providerWindows[source] = { start, end };
  };
  // Bundled-file reads and per-agent run costs, indexed once from the claude
  // walk for the per-row joins further down.
  const readsByAssetDir = new Map<string, { relPath: string; sessions: string[] }[]>();
  const agentTokens = new Map<string, number>();
  // Fires whose name matches nothing installed — typos, renamed and deleted
  // assets, another project's rules. Merged by NAME across providers so the
  // near-miss pass sees one entry per name instead of one per source.
  const windowExternal = new Map<string, number>();
  const addExternal = (name: string, count: number): void => {
    windowExternal.set(name, (windowExternal.get(name) ?? 0) + count);
  };
  if (opts.history) {
    // Claude-format assets — user, project, plugin, and explicit-directory
    // audits alike — all dispatch by name into ~/.claude/projects transcripts.
    const claudeDispatchable = rows.filter(
      (r) => (r.source === "claude" || r.source === "custom") && r.tracked
    );
    if (claudeDispatchable.length > 0) {
      const h = await historyFacts(
        ctx.transcripts ?? join(ctx.home, ".claude", "projects"),
        claudeDispatchable.map((r) => r.skill)
      );
      // Usage rows carry the kind the dispatch channel resolved (history.ts);
      // the name map is only a fallback for rows without one. A last-wins
      // overwrite here handed a shared dispatch name's fires to whichever
      // kind was discovered last, zeroing the other row.
      const kindOf = new Map(claudeDispatchable.map((r) => [r.skill.dirName, r.skill.kind ?? "skill"]));
      for (const u of h.usage) {
        const kind = u.kind ?? kindOf.get(u.skill) ?? "skill";
        usageByKey.set(joinKey("claude", kind, u.skill), toFires(u));
        usageByKey.set(joinKey("custom", kind, u.skill), toFires(u));
      }
      if (h.events) rawEvents.push(...h.events);
      for (const u of h.external) addExternal(u.skill, u.invocations);
      // Read paths that landed inside a tracked asset's own directory, keyed
      // by that directory — the "do its bundled files get used?" evidence.
      for (const r of h.fileReads ?? []) {
        const list = readsByAssetDir.get(r.dir);
        if (list) list.push({ relPath: r.relPath, sessions: r.sessions });
        else readsByAssetDir.set(r.dir, [{ relPath: r.relPath, sessions: r.sessions }]);
      }
      // Tokens summed from each subagent's OWN transcript; the agent rows below
      // join them through their launch events' agentId.
      for (const a of h.agentRuns ?? []) agentTokens.set(a.agentId, a.tokens);
      claudeWindowStart = h.windowStart;
      noteWindow("claude", h.windowStart, h.windowEnd);
      history = { transcriptFiles: h.transcriptFiles, windowStart: h.windowStart, windowEnd: h.windowEnd };
    }
    // Codex history runs whenever the tool is present and wanted, not only
    // when prompts were discovered: rollouts also carry the AGENTS.md loads
    // that the readBy join below needs, even on a prompt-less machine.
    if (!opts.dir && (!opts.sources || opts.sources.includes("codex")) && codexAdapter.detect(ctx) && codexAdapter.usage) {
      const codexPrompts = rows.filter((r) => r.source === "codex" && r.tracked).map((r) => r.skill);
      const h = await codexAdapter.usage(ctx, codexPrompts);
      for (const u of h.usage) usageByKey.set(joinKey("codex", "prompt", u.skill), toFires(u));
      if (h.events) rawEvents.push(...h.events);
      for (const u of h.external) addExternal(u.skill, u.invocations);
      codexWindowStart = h.windowStart;
      noteWindow("codex", h.windowStart, h.windowEnd);
      // The merged window and file count describe TRACKED rows. On a machine
      // with rollouts but no prompts, folding the rollout horizon in rebased
      // the claude-only window — "none in 180d" against 30 days of transcripts
      // is an overclaim. The events and loads above are kept either way.
      if (codexPrompts.length > 0) {
        history = {
          transcriptFiles: (history?.transcriptFiles ?? 0) + h.transcriptFiles,
          windowStart: [history?.windowStart, h.windowStart].filter(Boolean).sort()[0],
          windowEnd: [history?.windowEnd, h.windowEnd].filter(Boolean).sort().pop(),
        };
      }
    }
    // Cursor rule attachments out of the global conversation store. Gated on
    // the STORE, not on `cursorAdapter.detect()`: detect() asks only whether
    // the CWD has `.cursor/rules`, and the store is one file for every
    // workspace — so a machine with rules in one repo and the dashboard opened
    // in another would have reported "no readable history" with the whole
    // store sitting right there.
    if (
      !opts.dir &&
      (!opts.sources || opts.sources.includes("cursor")) &&
      cursorStorePath(ctx.home) &&
      cursorAdapter.usage
    ) {
      const cursorRules = rows.filter((r) => r.source === "cursor").map((r) => r.skill);
      const h = await cursorAdapter.usage(ctx, cursorRules);
      for (const u of h.usage) usageByKey.set(joinKey("cursor", "rule", u.skill), toFires(u));
      if (h.events) rawEvents.push(...h.events);
      // Rules belonging to OTHER projects are deliberately NOT collected as
      // external fires. The store is global, so most attachments are somebody
      // else's — and the only consumer of that bucket is the near-miss pass,
      // which merges by BARE NAME and renders its answer as "the likely
      // intended skill". A rule attachment is a passive load in another tool
      // and another repo, never an attempted dispatch of anything installed
      // here, so feeding it in turns an unrelated project's rule name into an
      // accusation of a typo against a Claude skill. The ledger path drops
      // these on exactly the same rule (`channel !== "load"`, below); this is
      // the window path's half of it.
      cursorWindowStart = h.windowStart;
      noteWindow("cursor", h.windowStart, h.windowEnd);
      // Tracked ONLY on a readable store (the adapter returns its one "file"
      // exactly when the read succeeded). A degraded read leaves the rows
      // untracked so they keep their honest "no readable history" instead of
      // rendering a 0 that looks like a measurement — the caveats below say
      // which failure produced it.
      if (h.transcriptFiles === 1) {
        for (const r of rows) if (r.source === "cursor") r.tracked = true;
      }
      // AFTER the usage call, never before: cursor's caveats() reports the
      // memoized outcome of that read — which failure made the store
      // unreadable, how many records carried no recognizable name — and asked
      // first it can only return its two static labels.
      caveats.push(...(cursorAdapter.caveats?.(ctx) ?? []));
    } else if (!opts.dir && (!opts.sources || opts.sources.includes("cursor")) && rows.some((r) => r.source === "cursor")) {
      // Rules discovered, no store to read them against: the rows' blank
      // history gets its reason stated rather than left as an unexplained gap.
      caveats.push(...(cursorAdapter.caveats?.(ctx) ?? []));
    }
  }

  // Claude's own qualifiers reach the dashboard too. Only cursor's did, which
  // meant a caveat the CLI report printed in full was silently absent from the
  // page the same scan produced — two surfaces disagreeing about what this
  // scan could and could not see. The plugin-version fallback keeps its
  // dedicated `pluginResolution` field (the page renders it as its own line),
  // so it is not duplicated here.
  if (!opts.dir && (!opts.sources || opts.sources.includes("claude"))) {
    caveats.push(
      ...(claudeAdapter.caveats?.(ctx) ?? []).filter((c: string) => !/^plugin versions resolved/.test(c))
    );
  }

  // The durable ledger: bank this window's events before the harness purges
  // its transcripts, then read the accumulated lifetime back. On failure the
  // payload degrades to the transcript-only figures it always had — an
  // unwritable dotdir must never take the scan down.
  let ledger: Ledger | undefined;
  let ledgerEvents: LedgerEvent[] = [];
  let metaTrackedSince: string | undefined;
  let ledgerCaveat: string | undefined;
  if (opts.history) {
    try {
      const l = openLedger(scanLedgerHome(ctx));
      // A session whose typed commands the hooks already captured belongs to
      // the hook: its transcript-derived typed events are dropped, not banked.
      // The two writers stamp different clocks into the id, so appending both
      // copies would double-count every typed command for hooks users.
      //
      // The key carries the provider, and the predicate below therefore names
      // no provider of its own. Ownership is per-provider by construction: a
      // Claude hook watches a Claude session and says nothing about what a
      // Codex rollout recorded, and two harnesses hand out session ids of the
      // same shape, so a bare id both suppresses fires it never observed and —
      // the failure that matters now that `hooks install --provider codex`
      // ships — lets a Codex rollout's typed prompt bank NEXT TO the Codex
      // hook's own event for it, double-counting every Codex prompt. This is
      // the same rule the CLI's banking path applies (sources/index.ts); the
      // two copies must stay in step or the CLI and the dashboard report
      // different Codex counts from one ledger.
      const hookTypedSessions = new Set(
        l.readEvents()
          .filter((e) => e.hook === true && e.channel === "typed")
          .map((e) => `${e.provider}:${e.sessionId}`)
      );
      l.appendEvents(
        rawEvents.filter(
          (e) => !(e.channel === "typed" && !e.hook && hookTypedSessions.has(`${e.provider}:${e.sessionId}`))
        )
      );
      ledgerEvents = l.readEvents();
      metaTrackedSince = l.meta().trackedSince;
      ledger = l;
      // Lines the store could not parse are skipped by design (one torn line
      // must never take the scan down) — but skipped silently, every lifetime
      // figure below would be quietly short by whatever they held. The count
      // and the files it came from are stated instead.
      const diag = l.diagnostics();
      if (diag.malformedLines > 0) {
        const files = Object.entries(diag.byFile)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([file, n]) => `${file}: ${n}`)
          .join(", ");
        caveats.push(
          `usage ledger: ${diag.malformedLines} unreadable line${diag.malformedLines === 1 ? "" : "s"} ` +
            `skipped (${files}) — lifetime figures omit whatever they recorded`
        );
      }
    } catch (err) {
      ledger = undefined;
      ledgerEvents = [];
      const why = String((err as Error)?.message ?? err).slice(0, 120);
      ledgerCaveat =
        `usage ledger unavailable (${why}) — lifetime figures, provenance and ` +
        `dead-weight are omitted; usage figures reflect the current transcript window only`;
    }
  }
  opts.onLedger?.(ledger);
  // The backfill horizon: the typed channel reaches back to the oldest
  // imported history.jsonl entry, further than any surviving transcript. The
  // spec's label ("typed-channel history extends to <date> (backfilled)")
  // needs the date surfaced, not inferred.
  if (history) {
    const backfilled = ledgerEvents.filter((e) => e.backfill).map((e) => e.ts).sort()[0];
    if (backfilled) history.backfilledSince = backfilled;
  }

  const eventsByKey = new Map<string, LedgerEvent[]>();
  const loadsByDir = new Map<string, LedgerEvent[]>();
  const put = (m: Map<string, LedgerEvent[]>, k: string, e: LedgerEvent): void => {
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  };
  // Join-time kind authority. For claude dispatch events the CHANNEL is the
  // evidence — a typed fire belongs to the command row when a command owns the
  // name, an auto fire to the skill row — and a name installed under exactly
  // one kind takes all of its fires. The stored kind never decides a join
  // alone (hooks hard-code provisional kinds; older events carry last-wins
  // guesses), so already-banked mis-kinded events heal here, at read time.
  const rekeyedKind = (e: LedgerEvent): AssetKind => {
    if (e.provider !== "claude" || e.channel === "load") return e.kind;
    if (e.kind !== "skill" && e.kind !== "command") return e.kind;
    const channelKind: AssetKind = e.channel === "typed" ? "command" : "skill";
    const set = claudeKinds.get(e.name);
    if (!set) return e.kind;
    if (set.has(channelKind)) return channelKind;
    return set.size === 1 ? [...set][0] : channelKind;
  };
  for (const e of ledgerEvents) {
    put(eventsByKey, joinKey(e.provider, rekeyedKind(e), e.name), e);
    // Passive loads name the loaded DIRECTORY; the item join below resolves
    // them back to the AGENTS.md asset living there.
    if (e.kind === "instructions" && e.channel === "load") put(loadsByDir, e.name, e);
  }

  // This row's ledger events, resolved ONCE per row. Every fact below —
  // fires, freshness, co-fired sessions, bundled reads, agent cost, disable
  // safety — asks the same question of the same list, and this runs on every
  // rescan button press: one map lookup per row, not one store scan per fact.
  const eventsByRow = new Map<Row, LedgerEvent[]>();
  for (const row of rows) {
    const kind = row.skill.kind ?? "skill";
    // A shadowed disabled copy never dispatches while its enabled twin exists,
    // so the name's events are the TWIN's history, not this row's. Handing
    // them over here would re-attribute every fire the shadowing rule exists
    // to keep on one row.
    const shadowed = !!(row.twinPath && !row.enabled);
    const provider = row.source === "custom" ? "claude" : row.source;
    eventsByRow.set(
      row,
      shadowed
        ? []
        : row.source === "agents-md" && kind === "instructions"
          ? loadsByDir.get(dirname(row.skill.dir)) ?? []
          : eventsByKey.get(joinKey(provider, kind, row.skill.dirName)) ?? []
    );
  }

  // Names that fired but match nothing installed. The live buckets above cover
  // the transcript window; the ledger reaches back to the tracking horizon, and
  // it banked this window's fires too — so the ledger's count SUPERSEDES the
  // window bucket for a name rather than adding to it, or today's typo would
  // be counted twice. Load events are excluded: their `name` is the loaded
  // DIRECTORY, and offering a path as a misspelled skill is nonsense.
  const installedKeys = new Set(
    rows.map((r) =>
      joinKey(r.source === "custom" ? "claude" : r.source, r.skill.kind ?? "skill", r.skill.dirName)
    )
  );
  const externalFires = new Map<string, number>(windowExternal);
  for (const [key, evts] of eventsByKey) {
    if (installedKeys.has(key)) continue;
    const dispatched = evts.filter((e) => e.channel !== "load");
    if (dispatched.length === 0) continue;
    const name = dispatched[0].name;
    externalFires.set(name, Math.max(dispatched.length, externalFires.get(name) ?? 0));
  }
  // ONE call per build: nearMissMap runs a bounded edit distance over
  // (external × installed), and asking it per row would repeat that product
  // once for every row it answers.
  const nearMissByName = nearMissMap(
    rows.map((r) => r.skill.dirName),
    [...externalFires.entries()].map(([name, count]) => ({ name, count }))
  );

  /** Monday of the event's ISO week, UTC — undefined for an unparseable ts. */
  const isoWeekStart = (ts: string): string | undefined => {
    const d = new Date(ts);
    // isLedgerEvent gates ts at the durable boundary; this is the sink's own
    // belt — one bad stored line must never brick the whole payload build.
    if (Number.isNaN(d.getTime())) return undefined;
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };

  /** Browser-bound projection: digested ids and display names only, never the src path. */
  const toFireEvent = (e: LedgerEvent): UiFireEvent => {
    const fe: UiFireEvent = { id: eventDigest(e.id), ts: e.ts, project: e.project ? basename(e.project) : "", channel: e.channel };
    if (e.outcome) fe.outcome = e.outcome;
    if (e.interrupted) fe.interrupted = true;
    // Imported from history.jsonl, not observed in a transcript — labeled so
    // the row never promises a transcript it does not have.
    if (e.backfill) fe.backfill = true;
    // The harness already purged this event's transcript: the drill-down row
    // renders disabled up front instead of after a dead open round-trip.
    if (e.src && !existsSync(e.src.file)) fe.purged = true;
    return fe;
  };

  /**
   * Window figures derived from a row's own ledger events, for the rows no
   * usage table covers: agent launches (history.ts keeps them out of its
   * aggregation on purpose — a subagent type in the usage list would read as
   * an uninstalled skill) and AGENTS.md loads.
   *
   * `winStart` is the PROVIDER's own window start, never the merged one: the
   * merged minimum can describe another harness's transcripts entirely, and
   * counting against it is what turns a window figure into a claim about a
   * period nobody observed.
   */
  const windowFires = (evts: LedgerEvent[], winStart: string | undefined): UiFires | null => {
    if (evts.length === 0) return null;
    const inWindow = winStart ? evts.filter((e) => e.ts >= winStart) : evts;
    return {
      invocations: inWindow.length,
      sessions: new Set(inWindow.map((e) => e.sessionId)).size,
      firstFired: inWindow[0]?.ts,
      lastFired: inWindow[inWindow.length - 1]?.ts,
      interruptedAfter: inWindow.filter((e) => e.interrupted).length,
    };
  };

  // Ledger enrichment: lifetime figures set beside the window figures, never
  // conflated — every lifetime number carries trackedSince as its qualifier.
  // With no ledger the window-only shape (current behavior) passes through.
  //
  // `kind` decides one facet only (see byAgent) and is otherwise unused: it is
  // passed rather than inferred because the same event stream means different
  // things on an agent row than on a skill row.
  const withLedger = (base: UiFires | null, evts: LedgerEvent[], kind: AssetKind): UiFires | null => {
    if (!ledger) return base;
    if (base === null && evts.length === 0) return null;
    const f: UiFires = base ? { ...base } : { invocations: 0, sessions: 0, interruptedAfter: 0 };
    f.lifetime = {
      invocations: evts.length,
      sessions: new Set(evts.map((e) => e.sessionId)).size,
      firstFired: evts[0]?.ts,
      lastFired: evts[evts.length - 1]?.ts,
    };
    // A backfilled event can predate the meta horizon; the older proof wins.
    f.trackedSince =
      metaTrackedSince && evts[0] && evts[0].ts < metaTrackedSince ? evts[0].ts : metaTrackedSince;
    if (evts.length > 0) {
      const auto = evts.filter((e) => e.channel === "auto").length;
      const typed = evts.filter((e) => e.channel === "typed").length;
      // Loads are neither model-dispatched nor typed; a load-only asset gets no split.
      if (auto + typed > 0) f.byChannel = { auto, typed };
      const byProvider: Partial<Record<SourceId, number>> = {};
      for (const e of evts) byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
      f.byProvider = byProvider;
      // Lifetime fires per project — the S1 "which projects?" answer. Display
      // basenames only: browser-bound rows carry no filesystem paths.
      const byProject = new Map<string, number>();
      for (const e of evts) {
        const p = e.project ? basename(e.project) : "(unknown)";
        byProject.set(p, (byProject.get(p) ?? 0) + 1);
      }
      f.byProject = [...byProject.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([name, count]) => ({ name, count }));
      const outcomes = { ok: 0, error: 0, rejected: 0 };
      for (const e of evts) if (e.outcome) outcomes[e.outcome]++;
      f.outcomes = outcomes;
      const bins = new Map<string, number>();
      for (const e of evts) {
        const w = isoWeekStart(e.ts);
        if (w) bins.set(w, (bins.get(w) ?? 0) + 1);
      }
      f.weeklyBins = [...bins.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([weekStart, count]) => ({ weekStart, count }));
      f.events = evts.slice(-50).reverse().map(toFireEvent);

      // "Is it my automation, not me?" — interactive against automated. The
      // three buckets are kept apart deliberately: most banked events carry no
      // entrypoint at all (only the claude transcript walk records one), and
      // folding those into "interactive" would invent the very split this is
      // asked to measure. An all-unknown row is a measured "we cannot say".
      let interactive = 0;
      let automated = 0;
      let unknownEntry = 0;
      for (const e of evts) {
        if (e.entrypoint === undefined) unknownEntry++;
        else if (e.entrypoint === "cli") interactive++;
        else automated++;
      }
      f.byEntrypoint = { interactive, automated, unknown: unknownEntry };

      // "Main agent or subagents?" — an event carrying `agent` fired inside a
      // sidechain. NOT computed on agent rows: history.ts writes the SPAWNED
      // agent's id into that same field on a launch event (the result line is
      // the only place the id appears, and the run-cost join below needs it),
      // so on an agent row the field says "this launch produced agent X", not
      // "this fire happened inside a sidechain" — and every launch would be
      // reported as a sidechain fire.
      if (kind === "skill" || kind === "command" || kind === "prompt") {
        const sidechain = evts.filter((e) => e.agent !== undefined).length;
        f.byAgent = { main: evts.length - sidechain, sidechain };
      }

      // "Which model picks it?" — absent, not zeroed, when no event recorded a
      // model: `<synthetic>` lines are excluded at capture and the typed and
      // load channels never carry one.
      const byModel = new Map<string, number>();
      for (const e of evts) if (e.model) byModel.set(e.model, (byModel.get(e.model) ?? 0) + 1);
      if (byModel.size > 0) {
        f.byModel = [...byModel.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([model, count]) => ({ model, count }));
      }

      const stamps = evts
        .map((e) => Date.parse(e.ts))
        .filter((ms) => !Number.isNaN(ms))
        .sort((a, b) => a - b);
      if (stamps.length > 0) {
        const first = stamps[0];
        const last = stamps[stamps.length - 1];
        // "Is this silence new for THIS skill?" — a 34-day gap means nothing
        // until you know its longest previous gap was 12. Absent below two
        // fires: there is no prior gap to compare the silence against, and
        // printing one anyway would be an invented baseline.
        if (stamps.length >= 2) {
          let longest = 0;
          for (let i = 1; i < stamps.length; i++) longest = Math.max(longest, stamps[i] - stamps[i - 1]);
          f.quiet = {
            days: Math.max(0, Math.floor((scanNow - last) / DAY_MS)),
            longestPriorGapDays: Math.floor(longest / DAY_MS),
            gapsCounted: stamps.length - 1,
          };
        }
        // "Staple or one-burst?" — active weeks over the weeks this item has
        // existed in the record. Both sides are counted in ISO weeks (the same
        // bins the trend strip draws) so the ratio compares like with like,
        // and the denominator can never come out smaller than the count it
        // contains, whatever a skewed clock says.
        const activeWeeks = f.weeklyBins.length;
        const firstWeek = Date.parse(isoWeekStart(new Date(first).toISOString()) ?? "");
        const nowWeek = Date.parse(isoWeekStart(scanNowIso) ?? "");
        const weeksSinceFirst =
          Number.isNaN(firstWeek) || Number.isNaN(nowWeek)
            ? activeWeeks
            : Math.max(activeWeeks, Math.round((nowWeek - firstWeek) / (7 * DAY_MS)) + 1);
        f.spread = {
          activeWeeks,
          weeksSinceFirst,
          spanDays: Math.floor((last - first) / DAY_MS),
          // One fire is not a burst — it is one fire, and badging it "tried &
          // dropped" would put a verdict on a single data point.
          oneBurst: stamps.length >= 2 && last - first <= 7 * DAY_MS,
        };
      }
    }
    return f;
  };

  // Exact dispatch-name copies within one provider+kind: no transcript
  // evidence can split the name's fires between them, so every copy carries
  // the warning. The enabled/disabled twin pair is NOT a collision — the
  // shadowing rule above already attributes the name's history to the
  // enabled copy alone.
  const collisionByRow = new Map<Row, string[]>();
  {
    const byDispatch = new Map<string, Row[]>();
    for (const row of rows) {
      const k = joinKey(row.source, row.skill.kind ?? "skill", row.skill.dirName);
      const group = byDispatch.get(k);
      if (group) group.push(row);
      else byDispatch.set(k, [row]);
    }
    for (const group of byDispatch.values()) {
      if (group.length < 2) continue;
      if (group.length === 2 && group[0].twinPath === group[1].skill.dir) continue;
      for (const row of group) {
        collisionByRow.set(row, group.filter((r) => r !== row).map((r) => r.skill.dir));
      }
    }
  }
  // The same dispatch name installed as BOTH a skill and a command in one
  // source: the channel evidence splits typed from auto fires between the two
  // rows, but nothing can prove a typed fire meant the command rather than
  // the skill — every copy carries the cannot-split warning instead of one
  // row silently reading zero.
  {
    const byName = new Map<string, Row[]>();
    for (const row of rows) {
      if (!row.tracked) continue;
      const kind = row.skill.kind ?? "skill";
      if (kind !== "skill" && kind !== "command") continue;
      const k = `${row.source}\u0000${row.skill.dirName}`;
      const group = byName.get(k);
      if (group) group.push(row);
      else byName.set(k, [row]);
    }
    for (const group of byName.values()) {
      if (new Set(group.map((r) => r.skill.kind ?? "skill")).size < 2) continue;
      for (const row of group) {
        const others = group
          .filter((r) => r !== row && (r.skill.kind ?? "skill") !== (row.skill.kind ?? "skill"))
          .map((r) => r.skill.dir);
        const prior = collisionByRow.get(row) ?? [];
        collisionByRow.set(row, [...prior, ...others.filter((p) => !prior.includes(p))]);
      }
    }
  }

  const home = resolve(ctx.home);
  const cwd = resolve(ctx.cwd);
  // The project usually lives inside home, so a home prefix test alone would
  // claim every project file as user-scoped. The reverse also happens — run
  // the dashboard from `/Users` and cwd is an ANCESTOR of home, which labelled
  // every user skill "project". Neither containment direction decides this by
  // itself: an asset under home is user-scoped unless cwd sits deeper.
  const under = (dir: string, root: string): boolean => dir === root || dir.startsWith(root + sep);
  const cwdInsideHome = cwd !== home && under(cwd, home);

  // Scope is decided for every row BEFORE any row renders: the wrong-scope
  // note asks whether the same dispatch name also exists at the OTHER scope,
  // which cannot be answered while the other row's own answer is still being
  // computed.
  const scopeOf = new Map<Row, "user" | "project">();
  for (const row of rows) {
    const inProject =
      cwd !== home && under(row.skill.dir, cwd) && (cwdInsideHome || !under(row.skill.dir, home));
    scopeOf.set(row, inProject ? "project" : "user");
  }
  // Keyed by SOURCE + name: "the same name at both scopes" is a fact about one
  // harness's dispatch table. A cursor rule and a claude skill sharing a name
  // never compete — they are read by different tools.
  const scopesByName = new Map<string, Set<"user" | "project">>();
  for (const row of rows) {
    const k = `${row.source}\u0000${row.skill.dirName}`;
    const set = scopesByName.get(k) ?? new Set<"user" | "project">();
    set.add(scopeOf.get(row) ?? "user");
    scopesByName.set(k, set);
  }

  // Item ids resolved once, up front: the cross-provider and confusable joins
  // below cross-link rows BY ID, so they need every row's id before the item
  // map runs — and both surfaces must derive it identically or a cross-link
  // points at nothing.
  const idOf = new Map<Row, string>();
  for (const row of rows) idOf.set(row, itemId(row.source, row.skill.kind ?? "skill", row.skill.dir));

  // "Duplicated across providers?" — the same dispatch name under a DIFFERENT
  // harness, with a body-hash comparison behind the `identical` claim rather
  // than a name match dressed up as one. Grouped once: per-row scanning would
  // be O(items²) on a 200-asset machine.
  const crossByRow = new Map<Row, NonNullable<UiItem["crossProvider"]>>();
  {
    const byName = new Map<string, Row[]>();
    for (const row of rows) {
      const group = byName.get(row.skill.dirName);
      if (group) group.push(row);
      else byName.set(row.skill.dirName, [row]);
    }
    // Hashed at most once per row however many providers share the name.
    const hashes = new Map<Row, string>();
    const hashOf = (r: Row): string => {
      const memo = hashes.get(r);
      if (memo !== undefined) return memo;
      // Skill.body is already frontmatter-stripped, which is the point: the
      // same instructions ported between harnesses legitimately carry
      // different frontmatter keys, and hashing the raw file would report
      // every genuine twin as different.
      const h = bodyHash(r.skill.body);
      hashes.set(r, h);
      return h;
    };
    for (const group of byName.values()) {
      if (group.length < 2 || new Set(group.map((r) => r.source)).size < 2) continue;
      for (const row of group) {
        const others = group.filter((r) => r.source !== row.source);
        if (others.length === 0) continue;
        crossByRow.set(
          row,
          others.map((o) => ({
            itemId: idOf.get(o) as string,
            source: o.source,
            name: o.skill.dirName,
            identical: hashOf(row) === hashOf(o),
          }))
        );
      }
    }
  }

  // "Is a twin stealing its fires?" — items whose descriptions are identical
  // after the SAME normalization content.ts's duplicate detection applies
  // (lowercased, whitespace folded), so the dashboard and the report never
  // disagree about what a duplicate is. Grouped within one source: dispatch
  // confusion is a choice made inside one harness's listing.
  //
  // Only computed with a ledger open. The per-member figure is a LIFETIME fire
  // count, and without the store every member would read "fired 0 times" —
  // which is the store's absence, not a measurement of the twin.
  const confusableByRow = new Map<Row, NonNullable<UiItem["confusable"]>>();
  const coFiredByRow = new Map<Row, number>();
  if (ledger) {
    const byDesc = new Map<string, Row[]>();
    for (const row of rows) {
      // Enabled rows only. A disabled asset is not in the listing the model
      // chooses from, so it can take a fire from nothing — and the shadowed
      // half of a skills-disabled twin pair would otherwise be printed as a
      // rival with "fired 0 times" beside the copy it is a copy OF.
      if (!row.enabled) continue;
      const desc = row.skill.description?.trim();
      if (!desc) continue;
      const k = `${row.source}\u0000${desc.toLowerCase().replace(/\s+/g, " ")}`;
      const group = byDesc.get(k);
      if (group) group.push(row);
      else byDesc.set(k, [row]);
    }
    const sessionsOf = (r: Row): Set<string> =>
      new Set((eventsByRow.get(r) ?? []).map((e) => e.sessionId));
    for (const group of byDesc.values()) {
      if (group.length < 2) continue;
      for (const row of group) {
        const others = group.filter((r) => r !== row);
        confusableByRow.set(
          row,
          others.map((o) => ({
            itemId: idOf.get(o) as string,
            name: o.skill.dirName,
            fires: (eventsByRow.get(o) ?? []).length,
          }))
        );
        // Sessions where this item AND one of its twins both fired — the
        // sharpest evidence that the pair actually competes, rather than
        // living in different projects and never meeting.
        const twinSessions = new Set<string>();
        for (const o of others) for (const sid of sessionsOf(o)) twinSessions.add(sid);
        let coFired = 0;
        for (const sid of sessionsOf(row)) if (twinSessions.has(sid)) coFired++;
        coFiredByRow.set(row, coFired);
      }
    }
  }

  // "Was disabling safe?" needs to know who else names this asset — built ONCE
  // over ALL rows, enabled and disabled, every provider: a graph that excluded
  // half the callers could not answer the question it exists for. Built only
  // when something is disabled, because nothing else consumes it and it walks
  // every body on the machine.
  const refGraph = rows.some((r) => !r.enabled)
    ? referencedBy(rows.map((r) => ({ name: r.skill.dirName, body: r.skill.body })))
    : undefined;

  // ONE cache for the whole build, never module-level: the server rescans on a
  // button press, and a process-lifetime memo would answer the second scan
  // with the first scan's repository state.
  const healthCache = createHealthCache();
  // Each item's ledger events, kept for the post-passes below (install → first
  // fire, the plugin update boundary) that cannot run until provenance and
  // plugin dates are resolved.
  const evtsOfItem = new Map<UiItem, LedgerEvent[]>();

  const items: UiItem[] = rows.map((row) => {
    const s = row.skill;
    const kind = s.kind ?? "skill";
    const evts = eventsByRow.get(row) ?? [];
    const item: UiItem = {
      id: idOf.get(row) as string,
      name: s.dirName,
      source: row.source,
      kind,
      path: s.dir,
      scope: scopeOf.get(row) ?? "user",
      enabled: row.enabled,
      togglable: row.togglable,
      readOnlyReason: row.readOnlyReason,
      plugin: row.plugin,
      description: s.description?.trim() || undefined,
      frontmatter: entryFrontmatter(s),
      injection: s.injection ?? "description",
      // An unparseable item declares nothing, so the harness injects nothing
      // for it. Pricing it at its directory-name length would put a number in
      // the header total that the setup does not actually pay.
      injectedChars: s.hasSkillMd ? injectedChars(s) : 0,
      bodyChars: s.body.length,
      findings: findingsByRow.get(row) ?? [],
    };
    if (row.twinPath) item.twinPath = row.twinPath;
    const collision = collisionByRow.get(row);
    if (collision) item.collision = { paths: collision };
    // Fires are recorded by dispatch name. A shadowed disabled copy never
    // dispatches while its enabled twin exists, so handing it the name's
    // count would report the same fires twice; it gets no fires field and
    // the frontend explains why instead of showing "n/a — untracked".
    if (row.tracked && opts.history && !(row.twinPath && !row.enabled)) {
      // Which pipeline produced this row's WINDOW figure, and which window it
      // was counted against:
      //
      //   agent  — history.ts keeps agent launches out of its usage
      //     aggregation on purpose (a subagent type listed there would read as
      //     an uninstalled skill), so the ledger is the ONLY thing that
      //     measures them, and reading the usage table's miss as a measurement
      //     would print a confident "0 in 30d" beside a lifetime count of 30.
      //   cursor — the adapter aggregates every attachment in a GLOBAL store
      //     with no windowing at all, so its store-wide total (fifteen months
      //     on the machine this was found on) went into the window slot and was
      //     printed as "2 in 43d" under Claude's transcript horizon. Counted
      //     here against CURSOR's own window start, so the figure means what
      //     every other row's means: fires inside the span its provider was
      //     observed over.
      //
      // Both read the ledger, and a ledger that would not open measures
      // nothing. `null` is this payload's "tracked, never fired" — itself a
      // measurement — so an agent row, which has no other pipeline, gets no
      // fires field at all and renders n/a beside the caveat that says why.
      // A cursor row keeps the adapter's figure in that case: the store read
      // still happened, and its total already spans exactly cursor's window.
      const usage = usageByKey.get(joinKey(row.source, kind, s.dirName)) ?? null;
      const fromLedger = ledger !== undefined && (kind === "agent" || row.source === "cursor");
      if (ledger || kind !== "agent") {
        item.fires = withLedger(fromLedger ? windowFires(evts, windowStartFor(row.source)) : usage, evts, kind);
      }
    }
    if (kind === "instructions") {
      if (row.source === "agents-md") {
        // AGENTS.md loads are recorded against the provider that READ the
        // file, naming the loaded directory — resolved back to this file when
        // this row's events were gathered.
        if (evts.length > 0) {
          item.readBy = [...new Set(evts.map((e) => e.provider))].sort();
          // Loads come from codex rollouts, so "in window" means CODEX's own
          // window — the merged one may describe claude transcripts only. That
          // mapping lives in windowStartFor, with every other provider's.
          item.fires = withLedger(windowFires(evts, windowStartFor(row.source)), evts, kind);
        }
      } else if (row.source === "codex") {
        // ~/.codex/AGENTS.md is codex's own global file — read by codex in
        // every session by construction, no load event needed to prove it.
        item.readBy = ["codex"];
      }
    }
    if (!s.hasSkillMd) item.parseError = true;

    // --- content health, relationships, and the joins that need both -------
    // Every fact below is omitted rather than zeroed when its evidence is
    // missing: on this surface an absent section reads as "not observed" and a
    // 0 reads as "observed none", and only one of those is ever true here.

    // Fire-derived facts are stated only where this row HAS fire tracking. An
    // untracked row renders "n/a" for fires, and "0 fires since your edit"
    // printed beside it would be a number the payload just said it does not
    // have.
    const fireEvents = item.fires !== undefined ? evts : [];
    if (item.fires !== undefined) {
      const fresh = freshnessOf({ path: s.dir, files: s.files.map((f) => f.absPath) }, healthCache);
      const days = fresh ? daysSince(fresh.editedAt) : undefined;
      if (fresh && days !== undefined) {
        const editedMs = Date.parse(fresh.editedAt);
        // Both readings of one pair of inputs: "edited 5d ago — 2 fires since"
        // and "unchanged 187d · 41 fires in that span".
        //
        // The count covers the OBSERVED part of that span and nothing more:
        // the ledger reaches back to `fires.trackedSince`, which on an old
        // asset is far more recent than its edit date, so "41 fires in that
        // span" is 41 fires in whatever slice of those 187 days was watched.
        // The qualifier that makes it readable is `fires.trackedSince`, which
        // is in the payload beside it — the renderer states the count's own
        // start whenever it is later than the edit (and states that nothing
        // measured it at all when there is no ledger and trackedSince is
        // absent). This side must not silently widen it.
        item.freshness = {
          editedAt: fresh.editedAt,
          days,
          firesSince: fireEvents.filter((e) => Date.parse(e.ts) > editedMs).length,
          source: fresh.source,
        };
      }
    }

    // undefined means there was no entry text to analyze — an unparsed asset
    // gets NO refs section rather than a `checked: 0` that reads as a clean
    // bill of health.
    const refs = resolveRefs({ path: s.dir, entry: entryText(s) });
    if (refs) item.refs = refs;

    const cross = crossByRow.get(row);
    if (cross && cross.length > 0) item.crossProvider = cross;

    const twins = confusableByRow.get(row);
    if (twins && twins.length > 0) {
      item.confusable = twins;
      item.coFiredSessions = coFiredByRow.get(row) ?? 0;
    }

    const misses = nearMissByName.get(s.dirName);
    // Absent, never `[]`: an empty list would render as "we looked and found
    // nothing", which is a different claim from "nothing pointed here".
    if (misses && misses.length > 0) item.nearMiss = misses;

    const otherScope = item.scope === "user" ? "project" : "user";
    const scopeNote: NonNullable<UiItem["scopeNote"]> = {};
    // Two fires minimum: one fire is trivially "all in one project" and would
    // put a scope note on every barely-used item on the machine.
    if (item.scope === "user" && fireEvents.length >= 2) {
      const projects = new Set(fireEvents.map((e) => e.project).filter((p) => p));
      if (projects.size === 1) scopeNote.allFiresIn = basename([...projects][0]);
    }
    if (scopesByName.get(`${row.source}\u0000${s.dirName}`)?.has(otherScope)) {
      scopeNote.alsoAtScope = otherScope;
    }
    if (scopeNote.allFiresIn || scopeNote.alsoAtScope) item.scopeNote = scopeNote;

    // "Do its bundled files get used?" — Read tool_use paths that landed
    // inside this asset's own directory.
    const reads = readsByAssetDir.get(s.dir.replace(/[\\/]+$/, ""));
    if (reads && reads.length > 0) {
      // The reads were observed in the CLAUDE transcript window, so the
      // denominator is this item's fire sessions IN THAT SAME WINDOW: the
      // lifetime session count includes sessions whose transcripts are long
      // gone, and dividing window reads by it would understate every share.
      const fireSessions = new Set(
        (claudeWindowStart ? fireEvents.filter((e) => e.ts >= claudeWindowStart) : fireEvents).map(
          (e) => e.sessionId
        )
      );
      item.bundledFiles = reads.map((r) => ({
        relPath: r.relPath,
        // Sessions where the file was read AND this item fired. `sessions`
        // exists precisely to keep "someone opened the file" apart from "a
        // fire read it", and r.sessions.length would pool the two.
        readInFires: r.sessions.filter((sid) => fireSessions.has(sid)).length,
        ofFires: fireSessions.size,
      }));
    }

    // Per-AGENT run cost — near-exact, because each run's work lives in its
    // own `subagents/agent-<id>.jsonl`. Every launch event carries the id of
    // the transcript it spawned; a launch whose transcript has been purged is
    // simply NOT PRICED. Counting it as a zero-token run would drag the median
    // toward zero and report a missing measurement as a cheap one, and an
    // empty agentRuns map yields no agentCost at all rather than a bare 0.
    if (kind === "agent" && agentTokens.size > 0) {
      const priced = new Set<string>();
      const runs: number[] = [];
      for (const e of fireEvents) {
        // Only where the stamped id provably names the agent this launch
        // SPAWNED (see spawnedAgentId): the same field carries the CONTAINING
        // sidechain's id on a launch made from inside one, and joining on that
        // prices the parent run's whole transcript onto this row — a real
        // number attached to the wrong agent, and counted twice besides.
        const id = spawnedAgentId(e);
        // Deduped by agent id: one subagent transcript is one run's cost,
        // however many launch events reference it.
        if (!id || priced.has(id)) continue;
        const tokens = agentTokens.get(id);
        if (tokens === undefined) continue;
        priced.add(id);
        runs.push(tokens);
      }
      if (runs.length > 0) {
        runs.sort((a, b) => a - b);
        const mid = runs.length >> 1;
        item.agentCost = {
          runs: runs.length,
          totalTokens: runs.reduce((sum, t) => sum + t, 0),
          medianTokens: runs.length % 2 === 1 ? runs[mid] : Math.round((runs[mid - 1] + runs[mid]) / 2),
        };
      }
    }

    // "Is the plugin update relevant?" — a byte comparison against the newest
    // version still in the cache. undefined means UNKNOWN (nothing newer on
    // disk to compare against), which is not the claim "this update leaves the
    // skill alone"; the call returns early in that case, so a machine with one
    // version per plugin pays a directory listing and nothing more.
    if (row.install) {
      const relevance = updateRelevance(ctx.home, row.install, item.path);
      if (relevance) item.updateRelevance = relevance;
    }

    // "Was disabling safe?" — attempted invocations of the name since it
    // stopped resolving, plus the assets whose bodies still point at it.
    // Skipped for a SHADOWED copy (a disabled row with a twin): its name still
    // dispatches, to the enabled copy, so a fire after the move is that copy
    // working rather than an attempt at something missing.
    if (!row.enabled && !row.twinPath) {
      const at = disabledAt(row);
      // Gated on having a date at all: `attemptsSince` is meaningless without
      // the "since", and a lifetime count relabeled as attempts-since-disable
      // would be a fabricated one.
      if (at) {
        const atMs = Date.parse(at);
        item.disabledSafety = {
          disabledAt: at,
          disabledAtSource: "ctime",
          days: Math.max(0, Math.floor((scanNow - atMs) / DAY_MS)),
          attemptsSince: fireEvents.filter((e) => Date.parse(e.ts) > atMs).length,
          referencedBy: refGraph?.get(s.dirName) ?? [],
        };
      }
    }

    evtsOfItem.set(item, evts);
    return item;
  });

  // Install dates. Resolve only ids the store lacks — the first sighting was
  // snapshotted before the filesystem evidence decayed, so the store, not
  // this scan, is the source of truth for every item it already knows.
  if (ledger) {
    try {
      const firstTs = (i: UiItem): string | undefined => {
        if (i.source === "agents-md") return loadsByDir.get(dirname(i.path))?.[0]?.ts;
        const provider = i.source === "custom" ? "claude" : i.source;
        return eventsByKey.get(joinKey(provider, i.kind, i.name))?.[0]?.ts;
      };
      const stored = ledger.readProvenance();
      const unseen = items.filter((i) => !(i.id in stored));
      if (unseen.length > 0) {
        const resolved = resolveProvenance(
          unseen.map((i) => ({
            id: i.id,
            source: i.source,
            kind: i.kind,
            path: i.path,
            scope: i.scope,
            plugin: i.plugin,
            firstSeen: firstTs(i),
          })),
          { home: ctx.home, cwd: ctx.cwd }
        );
        ledger.writeProvenance(Object.fromEntries(resolved));
      }
      const current = unseen.length > 0 ? ledger.readProvenance() : stored;
      for (const i of items) {
        const p = current[i.id];
        if (p) i.provenance = p;
      }
    } catch (err) {
      // Provenance is a label on the rows, not a gate on the scan — but it is
      // also the dead-weight age gate's only input, and a silent failure there
      // reads as "nothing qualifies as dead weight" rather than "we could not
      // tell". The failure is stated so the missing amber has a reason.
      caveats.push(
        `install dates unavailable (${String((err as Error)?.message ?? err).slice(0, 120)}) — ` +
          `provenance lines and the dead-weight age gate are omitted this scan`
      );
    }
  }

  // Two facets that need a date the item map could not yet have: the install
  // date the provenance store just resolved, and the plugin manifest's update
  // boundary. Both are omitted rather than approximated.
  for (const item of items) {
    const f = item.fires;
    if (!f) continue;
    const first = f.lifetime?.firstFired;
    const p = item.provenance;
    if (first && p && f.trackedSince && p.source !== "first-seen" && p.installedAt >= f.trackedSince && p.installedAt <= first) {
      // Gated on the install date falling INSIDE observable history. An item
      // installed before tracking began has no recorded first fire, only a
      // first fire SINCE THE HORIZON — the interval between them would measure
      // when this tool started looking, not how long the user took to reach
      // for the skill. (A "first-seen" provenance IS the ledger's own first
      // event, so its interval is 0 by construction and says nothing at all.)
      const days = Math.floor((Date.parse(first) - Date.parse(p.installedAt)) / DAY_MS);
      if (Number.isFinite(days) && days >= 0) f.installToFirstFire = days;
    }

    const at = item.plugin?.lastUpdated;
    const evts = evtsOfItem.get(item) ?? [];
    if (at && evts.length > 0) {
      const atMs = Date.parse(at);
      // SYMMETRIC windows or nothing: "since update (12d): 0" is only a fact
      // beside the same 12 days before it — an open-ended "prior" would set a
      // fortnight against a lifetime and call the difference a change the
      // update caused. A same-day update has no prior window at all, and 0
      // fires inside a zero-length window is not an observation.
      //
      // And both halves have to be spans the ledger actually WATCHED. The
      // prior window was previously [at - days, at] with no reference to the
      // tracking horizon, so an update boundary older than that horizon
      // produced a hard `prior: 0` over months nobody observed — printed by
      // the drawer under "equal spans on both sides, so the two counts are
      // comparable", which is precisely the causal read that zero invites. So
      // the pair is clamped to the widest symmetric window that fits inside
      // observed history, and dropped entirely when tracking began at or after
      // the boundary: absent beats a confident 0.
      const trackedMs = f.trackedSince ? Date.parse(f.trackedSince) : NaN;
      const observedBefore = Number.isNaN(trackedMs) ? Infinity : Math.floor((atMs - trackedMs) / DAY_MS);
      const days = Math.min(Math.floor((scanNow - atMs) / DAY_MS), observedBefore);
      if (Number.isFinite(atMs) && days >= 1) {
        const stamps = evts.map((e) => Date.parse(e.ts)).filter((ms) => !Number.isNaN(ms));
        // Exactly `days` long on each side of the boundary. Where the clamp
        // bit, the "since" side stops short of the scan clock too — the two
        // counts are comparable or they are not stated.
        f.sinceUpdate = {
          at,
          days,
          since: stamps.filter((ms) => ms > atMs && ms <= atMs + days * DAY_MS).length,
          prior: stamps.filter((ms) => ms > atMs - days * DAY_MS && ms <= atMs).length,
        };
      }
    }
  }

  const enabledItems = items.filter((i) => i.enabled);
  const injected = enabledItems.reduce((sum, i) => sum + i.injectedChars, 0);

  // The skill listing, and the budget that silently truncates it. This is the
  // answer to "why has Claude stopped firing my skill?", so the dashboard has
  // to carry it — the CLI reported it from the start and the page did not,
  // which left the tool's most actionable number missing from its most-read
  // surface.
  //
  // Counted from the rows that are actually listed: enabled Claude skills,
  // user, project and plugin alike. Disabled ones are out of the directory
  // Claude Code reads, and no other vendor has this budget. The CLI inventories
  // plugins on the same terms, so the two surfaces report the identical figure
  // — they disagreed while only one of them could see plugins, which is
  // indefensible for a tool whose whole claim is that its numbers are facts.
  const listedRows = rows.filter(
    (r) => (r.source === "claude" || r.source === "custom") && r.enabled && (r.skill.kind ?? "skill") === "skill"
  );
  const listedChars = listedRows.reduce((sum, r) => sum + listingChars(r.skill), 0);
  const listing = listedChars > 0 ? listingBudget(listedChars) : undefined;
  const tracked = items.filter((i) => i.fires !== undefined);
  const flagged = items.filter((i) => i.findings.some((f) => f.level === "flag"));

  // Dead weight: enabled, tracked, zero fires in BOTH windows, and installed
  // before its provider's window began — present for the whole observed window
  // yet silent. That last clause is the empirical age gate: a younger item is
  // "too new to judge", not dead weight. Each item is judged against ITS
  // provider's window (windowStartFor) — an old codex rollout must never
  // stretch the horizon a claude skill is measured by, and a cursor rule
  // judged against Claude's ~30 days was being called silent over a store that
  // reaches back a year.
  let deadWeightChars: number | undefined;
  if (
    ledger &&
    (claudeWindowStart !== undefined || codexWindowStart !== undefined || cursorWindowStart !== undefined)
  ) {
    deadWeightChars = items
      .filter((i) => {
        const gate = windowStartFor(i.source);
        return (
          i.enabled &&
          i.fires !== undefined &&
          // BOTH windows, which is what the sentence above says. `??` fell
          // through only on a NULLISH lifetime, so a present-but-zero lifetime
          // hid a non-zero window count — and the two pipelines diverge by
          // construction: the ledger's built-ins gate refuses typed events the
          // transcript walk still counted, and a Skill block carrying no id
          // yields an invocation with no event behind it. An item the same
          // payload shows firing in the window is not silent.
          (i.fires === null || (i.fires.invocations === 0 && (i.fires.lifetime?.invocations ?? 0) === 0)) &&
          i.provenance !== undefined &&
          gate !== undefined &&
          i.provenance.installedAt < gate
        );
      })
      .reduce((sum, i) => sum + i.injectedChars, 0);
  }

  // The baseline the delta below is measured against, read BEFORE this run's
  // own line is appended — afterwards the newest snapshot is this scan, and a
  // payload diffed against itself reports "nothing changed" forever.
  //
  // The newest USABLE line: readSnapshots only guarantees a ts, so a line
  // written by a future schema (or hand-edited) can be missing the counts the
  // diff subtracts. Skipping it and naming the older scan it fell back to is
  // honest; NaN deltas rendered as "+NaN skills" are not.
  let prevSnapshot: LedgerSnapshot | undefined;
  if (ledger) {
    try {
      prevSnapshot = [...ledger.readSnapshots()]
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
        .reverse()
        .find((s) => typeof s.items === "number" && typeof s.injectedChars === "number");
    } catch {
      // No baseline is the first-scan case, which the delta already omits.
    }
  }

  // One snapshot line per audit run — the "since last scan" baseline.
  if (ledger) {
    const byProvider: Record<string, number> = {};
    for (const i of items) byProvider[i.source] = (byProvider[i.source] ?? 0) + 1;
    try {
      // listingChars rides along so the budget-crossing date stays derivable
      // later — injectedChars is a different figure (instruction bodies
      // included) and cannot stand in for the budgeted slice.
      const snap: LedgerSnapshot = {
        // The build's own clock: this line records the state the payload
        // beside it describes, so the two must carry the same instant.
        ts: scanNowIso,
        items: items.length,
        enabled: enabledItems.length,
        injectedChars: injected,
        byProvider,
        listingChars: listedChars,
      };
      ledger.appendSnapshot(snap);
    } catch (err) {
      // Snapshots power deltas, not this payload — but an unwritten line means
      // the NEXT scan measures its "since last scan" against an older baseline
      // than the reader expects, and the growth series loses this week's owned
      // point. Stated rather than swallowed.
      caveats.push(
        `this scan was not recorded in the snapshot history ` +
          `(${String((err as Error)?.message ?? err).slice(0, 120)}) — the next scan's ` +
          `since-last-scan figures will be measured against an older baseline`
      );
    }
  }

  // The latest under→over budget crossing in the snapshot history (this run's
  // line included) — the anchor for "went quiet around when the listing went
  // over budget". Snapshots from before listingChars was recorded are
  // unknown, not "under", so they never fabricate a crossing.
  if (ledger && listing) {
    try {
      let prev: number | undefined;
      let crossedAt: string | undefined;
      for (const s of [...ledger.readSnapshots()].sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
        const lc = s.listingChars;
        if (typeof lc !== "number") continue;
        if (prev !== undefined && prev <= LISTING_BUDGET_CHARS && lc > LISTING_BUDGET_CHARS) crossedAt = s.ts;
        prev = lc;
      }
      if (crossedAt) listing.crossedAt = crossedAt;
    } catch {
      // The crossing date annotates rows; its absence never blocks the payload.
    }
  }

  // --- portfolio · delta · budget cut · growth ---------------------------
  // Payload-level facts, every one of them derived from the durable store —
  // so every one is ABSENT without it, the rule deadWeightChars already
  // follows. A rollup computed from an unopened ledger would print "0 of 0
  // sessions used any skill", which is the store's absence rendered as a
  // measurement of the user's habits.
  let portfolio: UiPortfolio | undefined;
  let delta: UiDelta | undefined;
  let budgetCut: UiBudgetCut | undefined;
  let growth: UiGrowth | undefined;
  if (ledger) {
    // ONE pass over the whole store. Each figure below asks a different
    // question of the same event list, and the store is the largest thing this
    // build reads — a pass per stat is how the rescan button gets slow on
    // exactly the machine with the most history to show.
    //
    // Sessions are keyed provider + id, never the bare id: two harnesses hand
    // out session ids of the same shape, and pooling them would silently merge
    // a Codex session into a Claude one and shrink the denominator.
    const sessionsSeen = new Set<string>();
    const sessionsFired = new Set<string>();
    const sessionsByProvider = new Map<SourceId, Set<string>>();
    const firesByKey = new Map<string, number>();
    const firedKeysByWeek = new Map<string, Set<string>>();
    for (const e of ledgerEvents) {
      const session = `${e.provider}\u0000${e.sessionId}`;
      sessionsSeen.add(session);
      const perProvider = sessionsByProvider.get(e.provider);
      if (perProvider) perProvider.add(e.sessionId);
      else sessionsByProvider.set(e.provider, new Set([e.sessionId]));
      // A passive file load is not an invocation — it says the harness read a
      // file, not that the session reached for a skill. Counting loads as
      // fires would report every Codex session as having used one.
      if (e.channel === "load") continue;
      const key = joinKey(e.provider, rekeyedKind(e), e.name);
      const week = isoWeekStart(e.ts);
      // Claude Code's own slash commands are never part of what the user OWNS,
      // so they cannot join the series that is compared against owned counts —
      // on a store where the built-ins preference is on, a `/usage` poller
      // would otherwise carry the fired line on its own. They are already out
      // of the fire counts below, which admit installed rows only.
      const builtin = e.channel === "typed" && e.provider === "claude" && BUILTIN_COMMANDS.has(e.name);
      if (week && !builtin) {
        // Distinct things that fired that week, whether or not they are still
        // installed TODAY: a skill deleted last month was owned and firing
        // then, and filtering the past through the present inventory would
        // manufacture exactly the owned-outgrowing-used divergence this series
        // exists to test for.
        const set = firedKeysByWeek.get(week);
        if (set) set.add(key);
        else firedKeysByWeek.set(week, new Set([key]));
      }
      // Fires of a name nothing installs any more stay OUT of the numerator
      // and out of the concentration: each portfolio stat links to its own
      // pre-filtered proof view over rows, and a fire with no row to show
      // would make the printed number unverifiable on the very surface it
      // points at. The session still counts in the denominator — it happened.
      if (!installedKeys.has(key)) continue;
      sessionsFired.add(session);
      firesByKey.set(key, (firesByKey.get(key) ?? 0) + 1);
    }

    // The rows behind each dispatch key. Normally one; a name installed at two
    // scopes has several, and no transcript evidence can split that key's
    // fires between them — which is precisely what the collision warning on
    // those rows says — so the proof view has to show every copy or it would
    // list fewer fires than the stat above it claims. A shadowed disabled twin
    // is excluded on the same rule the event join uses: it cannot dispatch
    // while its enabled copy exists.
    const idsByKey = new Map<string, string[]>();
    for (const row of rows) {
      if (row.twinPath && !row.enabled) continue;
      const key = joinKey(
        row.source === "custom" ? "claude" : row.source,
        row.skill.kind ?? "skill",
        row.skill.dirName
      );
      const ids = idsByKey.get(key);
      if (ids) ids.push(idOf.get(row) as string);
      else idsByKey.set(key, [idOf.get(row) as string]);
    }

    const totalFires = [...firesByKey.values()].reduce((sum, n) => sum + n, 0);
    let concentration: UiPortfolio["concentration"];
    if (totalFires > 0) {
      // Ranked per DISPATCH KEY rather than per row: two rows sharing a name
      // hold the SAME events, and summing rows would count those fires twice
      // and push the percentage past 100.
      const ranked = [...firesByKey.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const ids: string[] = [];
      let cum = 0;
      let taken = 0;
      for (const [key, count] of ranked) {
        cum += count;
        taken++;
        ids.push(...(idsByKey.get(key) ?? []));
        // Decided on integers. Rounding 79.6 up to 80 for DISPLAY is fine;
        // deciding the cut on the rounded figure is not — the stat would then
        // name fewer items than actually carry the share it prints.
        if (cum * 100 >= totalFires * 80) break;
      }
      concentration = { items: taken, pct: Math.round((cum / totalFires) * 100), ids };
    }

    // Window spend: an item's injected chars are paid in EVERY session, so the
    // multiplier is the session count of the provider that loads it — never
    // its own fire count, and never the machine-wide session total, or a Codex
    // prompt would be billed for Claude Code's sessions.
    const sessionsFor = (i: UiItem): number => {
      // An AGENTS.md is paid by whichever harness READ it; everything else by
      // its own. A file nobody was observed reading has no observed spend.
      const providers: SourceId[] =
        i.source === "agents-md" ? i.readBy ?? [] : [i.source === "custom" ? "claude" : i.source];
      let n = 0;
      for (const p of providers) n += sessionsByProvider.get(p)?.size ?? 0;
      return n;
    };
    const topSpend = enabledItems
      .map((i) => ({ id: i.id, name: i.name, chars: i.injectedChars * sessionsFor(i) }))
      // Zero spend here means "no session of that provider was ever observed",
      // which is not the same claim as "this item is cheap" — an unmeasured
      // row has no place in a chart of measured ones.
      .filter((s) => s.chars > 0)
      .sort((a, b) => b.chars - a.chars || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, 5);

    // "Which flags matter first?" — a flag on something that runs daily
    // outranks a flag on a dormant file. Sorting by fires descending puts the
    // fired partition ahead of the silent one by construction; what follows is
    // the tie-break chain, ending on name so two otherwise identical rows
    // cannot swap places between two scans of an unchanged machine.
    const flaggedByActivity = flagged
      .map((i) => {
        // The row's OWN events, loads included (an AGENTS.md's load IS its
        // activation) — and only where the row reports a fires figure at all.
        // A card claiming "14 fires" beside a drawer reading "n/a" is a
        // contradiction the reader has no way to resolve.
        const evts = i.fires !== undefined ? evtsOfItem.get(i) ?? [] : [];
        const entry: UiPortfolio["flaggedByActivity"][number] = {
          id: i.id,
          name: i.name,
          fires: evts.length,
          projects: new Set(evts.map((e) => e.project).filter((p) => p)).size,
        };
        const last = evts[evts.length - 1]?.ts;
        if (last) entry.lastFired = last;
        return entry;
      })
      .sort((a, b) => {
        if (a.fires !== b.fires) return b.fires - a.fires;
        const la = a.lastFired ?? "";
        const lb = b.lastFired ?? "";
        if (la !== lb) return la < lb ? 1 : -1;
        if (a.projects !== b.projects) return b.projects - a.projects;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

    portfolio = {
      sessionsWithFires: sessionsFired.size,
      sessions: sessionsSeen.size,
      topSpend,
      flaggedByActivity,
    };
    // Absent with no fires on record: "0 items account for 0% of fires" is a
    // sentence about nothing.
    if (concentration) portfolio.concentration = concentration;

    if (prevSnapshot) {
      // Snapshots record no plugin versions, so "1 plugin updated" is derived
      // from the manifest instead: `lastUpdated` is "the current version has
      // been in place since", so a plugin whose lastUpdated falls after the
      // previous snapshot's ts moved between the two scans. A plugin whose
      // `installedAt` is ALSO after that ts is a new install rather than an
      // update — it is already counted in the items diff, and calling it an
      // update would invent a version change that never happened.
      const sinceMs = Date.parse(prevSnapshot.ts);
      const pluginsUpdated: UiDelta["pluginsUpdated"] = [];
      if (!Number.isNaN(sinceMs)) {
        for (const p of pluginInstalls) {
          const updatedMs = p.lastUpdated ? Date.parse(p.lastUpdated) : NaN;
          if (Number.isNaN(updatedMs) || updatedMs <= sinceMs) continue;
          const installedMs = p.installedAt ? Date.parse(p.installedAt) : NaN;
          if (!Number.isNaN(installedMs) && installedMs > sinceMs) continue;
          // No `from`: nothing on disk records the version that was live
          // before. A sentinel string here would render as if it were one.
          pluginsUpdated.push({ name: p.name, to: p.version });
        }
        pluginsUpdated.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      }
      delta = {
        since: prevSnapshot.ts,
        items: items.length - prevSnapshot.items,
        injectedChars: injected - prevSnapshot.injectedChars,
        pluginsUpdated,
      };
    }

    if (listing) {
      // Claude Code drops listing descriptions starting with the least-invoked
      // skills, so the KEEP order is most-fired first and the cut falls where
      // the running total passes the budget. Replayed over the REAL listing:
      // the same rows and the same per-row figure the header's percentage is
      // built from, because a budget bar that disagreed with the number
      // printed above it would be indefensible.
      let cum = 0;
      const order = listedRows
        .map((r) => ({
          id: idOf.get(r) as string,
          name: r.skill.dirName,
          chars: listingChars(r.skill),
          // Lifetime ledger fires — the deterministic stand-in for the
          // invocation counts Claude Code sorts on and keeps to itself. Loads
          // are excluded: a listed skill's fires are dispatches.
          fires: (eventsByRow.get(r) ?? []).filter((e) => e.channel !== "load").length,
        }))
        // Ties break on name, then id. Without a total order the same machine
        // renders a different cut line on two consecutive scans of an
        // inventory that did not change — and the row that "just got dropped"
        // would be a coincidence of iteration order.
        .sort((a, b) => {
          if (a.fires !== b.fires) return b.fires - a.fires;
          if (a.name !== b.name) return a.name < b.name ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map((e) => {
          cum += e.chars;
          // The running total only grows, so this IS the prefix rule the
          // harness applies: once the budget is passed everything after it is
          // dropped too, however small it is on its own.
          return { ...e, cumChars: cum, dropped: cum > listing.budgetChars };
        });
      budgetCut = {
        budgetChars: listing.budgetChars,
        // listing.chars, not a re-derived sum: the header's percentage and
        // this bar are then the same figure by construction.
        listingChars: listing.chars,
        order,
        headroomChars: Math.max(0, listing.chars - listing.budgetChars),
      };
    }

    // "Is the pile outgrowing use?" — two series over ISO weeks, from two
    // different sources, never mixed. `owned` is a snapshot OBSERVATION: a
    // week nobody scanned in has no owned value at all, because a smooth line
    // drawn through weeks this tool never saw is precisely the invented
    // history it exists to argue against.
    const ownedByWeek = new Map<string, number>();
    let snapshotsBegan: string | undefined;
    try {
      // Read AFTER this run's own append, so the current week carries today's
      // count rather than the last scan's.
      for (const s of [...ledger.readSnapshots()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
        if (typeof s.items !== "number") continue;
        const week = isoWeekStart(s.ts);
        if (!week) continue;
        if (!snapshotsBegan) snapshotsBegan = s.ts.slice(0, 10);
        // The last scan of a week wins: several scans are several observations
        // of that week, and the newest is the state the week ended in.
        ownedByWeek.set(week, s.items);
      }
    } catch {
      // No readable snapshots means no owned series; the fired bars stand alone.
    }
    const allWeeks = [...new Set([...ownedByWeek.keys(), ...firedKeysByWeek.keys()])].sort();
    // The recent end is anchored to THIS SCAN's week, never simply to the
    // newest key. MAX_GROWTH_WEEKS bounds the series from that end, so a single
    // line stamped in the future — a skewed clock, a transcript restored from
    // backup, a hand-edited file; `isLedgerEvent` accepts any ts that parses —
    // becomes `lastWeek` and trims every real week off the other end. A week
    // that has not happened is an observation of nothing, and dropping one
    // silently would leave an empty chart with no reason attached to it.
    const scanWeek = isoWeekStart(scanNowIso);
    const weekKeys = scanWeek ? allWeeks.filter((w) => w <= scanWeek) : allWeeks;
    const futureWeeks = allWeeks.length - weekKeys.length;
    if (futureWeeks > 0) {
      caveats.push(
        `the owned-vs-used series leaves out ${futureWeeks} week${futureWeeks === 1 ? "" : "s"} dated after ` +
          `this scan (a ledger line or snapshot stamped in the future) — nothing was observed there`
      );
    }
    if (weekKeys.length > 0) {
      const firstMs = Date.parse(`${weekKeys[0]}T00:00:00.000Z`);
      const lastMs = Date.parse(`${weekKeys[weekKeys.length - 1]}T00:00:00.000Z`);
      const weeks: UiGrowth["weeks"] = [];
      if (!Number.isNaN(firstMs) && !Number.isNaN(lastMs)) {
        // Weeks are emitted contiguously, so a quiet stretch renders AS a
        // quiet stretch instead of closing up into a line that never dipped.
        for (let ms = Math.max(firstMs, lastMs - (MAX_GROWTH_WEEKS - 1) * 7 * DAY_MS); ms <= lastMs; ms += 7 * DAY_MS) {
          const weekStart = new Date(ms).toISOString().slice(0, 10);
          const week: UiGrowth["weeks"][number] = {
            weekStart,
            firedItems: firedKeysByWeek.get(weekStart)?.size ?? 0,
          };
          const owned = ownedByWeek.get(weekStart);
          if (owned !== undefined) week.owned = owned;
          weeks.push(week);
        }
      }
      if (weeks.length > 0) {
        growth = {
          weeks,
          ownedSource:
            `owned = items counted by this tool's own scan that week` +
            `${snapshotsBegan ? `, first recorded ${snapshotsBegan}` : ""} — ` +
            `a week with no scan has no owned value, and none is interpolated`,
        };
      }
    }
  }

  return {
    version: packageVersion(),
    generatedAt: scanNowIso,
    tookMs: Date.now() - scanNow,
    root: opts.dir ? resolve(opts.dir) : `${ctx.home} + ${ctx.cwd}`,
    header: {
      items: items.length,
      providers: sources.length,
      listing,
      injectedChars: injected,
      injectedTokens: Math.ceil(injected / 4),
      neverFired: tracked.filter((i) => i.fires === null).length,
      tracked: tracked.length,
      deadWeightChars,
      flagged: flagged.length,
      flaggedHigh: items.filter((i) =>
        i.findings.some((f) => f.level === "flag" && (f.severity === "critical" || f.severity === "high"))
      ).length,
    },
    items,
    history,
    pluginResolution,
    ledgerCaveat,
    // Absent rather than empty: an empty caveat rail would read as "checked,
    // nothing to qualify" on a payload that may simply have had nothing to
    // qualify it against.
    caveats: caveats.length > 0 ? caveats : undefined,
    providerWindows: Object.keys(providerWindows).length > 0 ? providerWindows : undefined,
    portfolio,
    delta,
    budgetCut,
    growth,
    superseded,
  };
}
