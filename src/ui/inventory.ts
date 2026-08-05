import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { injectedChars } from "../content.js";
import { historyFacts } from "../history.js";
import { securityScan } from "../security.js";
import { discoverSkills, isSkillMd, parseFrontmatter } from "../skills.js";
import { ADAPTERS } from "../sources/index.js";
import { codexAdapter } from "../sources/codex.js";
import type { SourceContext } from "../sources/types.js";
import type {
  SecurityFinding,
  Skill,
  SkillUsage,
  SourceId,
  UiFires,
  UiItem,
  UiPayload,
  UiPluginMeta,
} from "../types.js";
import { discoverPluginAssets, latestKnownVersion, resolveActivePlugins } from "./plugins.js";

export interface UiBuildOptions {
  history: boolean;
  /** Explicit-directory mode: audit one claude-format skills directory. */
  dir?: string;
  sources?: SourceId[];
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

export async function buildUiPayload(ctx: SourceContext, opts: UiBuildOptions): Promise<UiPayload> {
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
  // Keyed by SOURCE + name. One flat name map let a Codex prompt hand its
  // invocation count to an identically named Claude command (`review` is a
  // plausible name in both), which is a fabricated number in a tool whose
  // entire claim is that it does not fabricate numbers.
  const usageByName = new Map<string, UiFires>();
  const usageKey = (source: string, name: string): string => `${source}\u0000${name}`;
  let history: UiPayload["history"];
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
      for (const u of h.usage) {
        usageByName.set(usageKey("claude", u.skill), toFires(u));
        usageByName.set(usageKey("custom", u.skill), toFires(u));
      }
      history = { transcriptFiles: h.transcriptFiles, windowStart: h.windowStart, windowEnd: h.windowEnd };
    }
    const codexPrompts = rows.filter((r) => r.source === "codex" && r.tracked).map((r) => r.skill);
    if (codexPrompts.length > 0 && codexAdapter.usage) {
      const h = await codexAdapter.usage(ctx, codexPrompts);
      for (const u of h.usage) usageByName.set(usageKey("codex", u.skill), toFires(u));
      history = {
        transcriptFiles: (history?.transcriptFiles ?? 0) + h.transcriptFiles,
        windowStart: [history?.windowStart, h.windowStart].filter(Boolean).sort()[0],
        windowEnd: [history?.windowEnd, h.windowEnd].filter(Boolean).sort().pop(),
      };
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
    // Fires are recorded by dispatch name. A shadowed disabled copy never
    // dispatches while its enabled twin exists, so handing it the name's
    // count would report the same fires twice; it gets no fires field and
    // the frontend explains why instead of showing "n/a — untracked".
    if (row.tracked && opts.history && !(row.twinPath && !row.enabled)) {
      item.fires = usageByName.get(usageKey(row.source, s.dirName)) ?? null;
    }
    if (!s.hasSkillMd) item.parseError = true;
    return item;
  });

  const enabledItems = items.filter((i) => i.enabled);
  const injected = enabledItems.reduce((sum, i) => sum + i.injectedChars, 0);
  const tracked = items.filter((i) => i.fires !== undefined);
  const flagged = items.filter((i) => i.findings.some((f) => f.level === "flag"));

  return {
    version: packageVersion(),
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    root: opts.dir ? resolve(opts.dir) : `${ctx.home} + ${ctx.cwd}`,
    header: {
      items: items.length,
      providers: sources.length,
      injectedChars: injected,
      injectedTokens: Math.ceil(injected / 4),
      neverFired: tracked.filter((i) => i.fires === null).length,
      tracked: tracked.length,
      flagged: flagged.length,
      flaggedHigh: items.filter((i) =>
        i.findings.some((f) => f.level === "flag" && (f.severity === "critical" || f.severity === "high"))
      ).length,
    },
    items,
    history,
    pluginResolution,
  };
}
