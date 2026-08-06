import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { LISTING_BUDGET_CHARS, injectedChars, listingBudget, listingChars } from "../content.js";
import { historyFacts } from "../history.js";
import { openLedger, type Ledger, type LedgerSnapshot } from "../ledger.js";
import { resolveProvenance } from "../provenance.js";
import { securityScan } from "../security.js";
import { discoverSkills, isSkillMd, parseFrontmatter } from "../skills.js";
import { ADAPTERS, scanLedgerHome, type AuditContext } from "../sources/index.js";
import { codexAdapter } from "../sources/codex.js";
import type {
  AssetKind,
  LedgerEvent,
  SecurityFinding,
  Skill,
  SkillUsage,
  SourceId,
  UiFireEvent,
  UiFires,
  UiItem,
  UiPayload,
  UiPluginMeta,
} from "../types.js";
import { discoverPluginAssets, latestKnownVersion, resolveActivePlugins } from "../plugins.js";

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
  /** Fire tracking exists for this row's kind (claude skills/commands, codex prompts). */
  tracked: boolean;
  /** The other copy's path when this name exists both enabled and disabled. */
  twinPath?: string;
}

const V1_READONLY = {
  plugin: "Plugin-managed — read-only in v1; enable or disable the plugin from Claude Code",
  project: "Project-scoped — the safe disable convention covers user skills only in v1",
  kind: "No safe disable convention for this kind in v1",
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

/** Frontmatter of the entry file, re-read for the drawer. */
function entryFrontmatter(skill: Skill): Record<string, string> | undefined {
  const entry =
    skill.files.find((f) => isSkillMd(f.relPath))?.content ??
    (skill.files.length === 1 ? skill.files[0]?.content : undefined);
  if (!entry) return undefined;
  const { fm } = parseFrontmatter(entry);
  return Object.keys(fm).length > 0 ? fm : undefined;
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
  const started = Date.now();
  const rows: Row[] = [];
  let pluginResolution: UiPayload["pluginResolution"];

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
        const userSkillsRoot = join(ctx.home, ".claude", "skills");
        // A direct child of the root, matching what toggle.ts will actually
        // accept. `startsWith(root + "/")` was both laxer (nested paths) and,
        // on Windows, never true at all — join() produces backslashes, so
        // every user skill silently lost its toggle.
        const isUserSkill =
          adapter.id === "claude" && kind === "skill" && dirname(skill.dir) === userSkillsRoot;
        rows.push({
          skill,
          source: adapter.id,
          enabled: true,
          togglable: isUserSkill,
          readOnlyReason: isUserSkill
            ? undefined
            : adapter.id !== "claude"
              ? V1_READONLY.vendor
              : kind === "skill"
                ? V1_READONLY.project
                : V1_READONLY.kind,
          tracked:
            (adapter.id === "claude" && (kind === "skill" || kind === "command")) ||
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
        for (const install of installs) {
          const latest = latestKnownVersion(ctx.home, install);
          for (const { skill } of discoverPluginAssets(install)) {
            rows.push({
              skill,
              source: "claude",
              enabled: install.enabled,
              togglable: false,
              readOnlyReason: V1_READONLY.plugin,
              plugin: { name: install.name, version: install.version, marketplace: install.marketplace, latest },
              tracked: skill.kind === "skill" || skill.kind === "command",
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
      claudeWindowStart = h.windowStart;
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
      codexWindowStart = h.windowStart;
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
      const hookTypedSessions = new Set(
        l.readEvents()
          .filter((e) => e.hook === true && e.channel === "typed")
          .map((e) => e.sessionId)
      );
      l.appendEvents(
        rawEvents.filter(
          (e) => !(e.provider === "claude" && e.channel === "typed" && !e.hook && hookTypedSessions.has(e.sessionId))
        )
      );
      ledgerEvents = l.readEvents();
      metaTrackedSince = l.meta().trackedSince;
      ledger = l;
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

  // Ledger enrichment: lifetime figures set beside the window figures, never
  // conflated — every lifetime number carries trackedSince as its qualifier.
  // With no ledger the window-only shape (current behavior) passes through.
  const withLedger = (base: UiFires | null, evts: LedgerEvent[]): UiFires | null => {
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

  const items: UiItem[] = rows.map((row) => {
    const s = row.skill;
    const kind = s.kind ?? "skill";
    const inProject =
      cwd !== home && under(s.dir, cwd) && (cwdInsideHome || !under(s.dir, home));
    const item: UiItem = {
      id: itemId(row.source, kind, s.dir),
      name: s.dirName,
      source: row.source,
      kind,
      path: s.dir,
      scope: inProject ? "project" : "user",
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
      // The ledger records events against the provider that dispatched them,
      // so an explicit-directory audit joins under "claude" like any other
      // claude-format asset.
      const ledgerProvider = row.source === "custom" ? "claude" : row.source;
      item.fires = withLedger(
        usageByKey.get(joinKey(row.source, kind, s.dirName)) ?? null,
        eventsByKey.get(joinKey(ledgerProvider, kind, s.dirName)) ?? []
      );
    }
    if (kind === "instructions") {
      if (row.source === "agents-md") {
        // AGENTS.md loads are recorded against the provider that READ the
        // file, naming the loaded directory — resolve them back to this file.
        const loads = loadsByDir.get(dirname(s.dir)) ?? [];
        if (loads.length > 0) {
          item.readBy = [...new Set(loads.map((e) => e.provider))].sort();
          // Loads come from codex rollouts, so "in window" means CODEX's own
          // window — the merged one may describe claude transcripts only.
          const winStart = codexWindowStart;
          const inWindow = winStart ? loads.filter((e) => e.ts >= winStart) : loads;
          item.fires = withLedger(
            {
              invocations: inWindow.length,
              sessions: new Set(inWindow.map((e) => e.sessionId)).size,
              firstFired: inWindow[0]?.ts,
              lastFired: inWindow[inWindow.length - 1]?.ts,
              interruptedAfter: 0,
            },
            loads
          );
        }
      } else if (row.source === "codex") {
        // ~/.codex/AGENTS.md is codex's own global file — read by codex in
        // every session by construction, no load event needed to prove it.
        item.readBy = ["codex"];
      }
    }
    if (!s.hasSkillMd) item.parseError = true;
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
    } catch {
      // Provenance is a label on the rows, not a gate on the scan.
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
  // before the transcript window began — present for the whole observed
  // window yet silent. That last clause is the empirical age gate: a younger
  // item is "too new to judge", not dead weight. Each item is judged against
  // ITS provider's window — an old codex rollout must never stretch the
  // horizon a claude skill is measured by.
  let deadWeightChars: number | undefined;
  if (ledger && (claudeWindowStart !== undefined || codexWindowStart !== undefined)) {
    deadWeightChars = items
      .filter((i) => {
        const gate = i.source === "codex" ? codexWindowStart : claudeWindowStart;
        return (
          i.enabled &&
          i.fires !== undefined &&
          (i.fires === null || (i.fires.lifetime?.invocations ?? i.fires.invocations) === 0) &&
          i.provenance !== undefined &&
          gate !== undefined &&
          i.provenance.installedAt < gate
        );
      })
      .reduce((sum, i) => sum + i.injectedChars, 0);
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
        ts: new Date().toISOString(),
        items: items.length,
        enabled: enabledItems.length,
        injectedChars: injected,
        byProvider,
        listingChars: listedChars,
      };
      ledger.appendSnapshot(snap);
    } catch {
      // Snapshots power deltas, not this payload; a failed append changes nothing here.
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

  return {
    version: packageVersion(),
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
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
  };
}
