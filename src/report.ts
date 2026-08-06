import type {
  AssetKind,
  HistoryFacts,
  LedgerEvent,
  MultiAuditResult,
  SecurityFinding,
  SourceAudit,
  SourceId,
} from "./types.js";
// The listing budget is Claude-specific, so it is only compared for claude
// sources below. The figure itself and the over/under call live in content.ts,
// so this report and the dashboard cannot drift apart on the tool's single
// most actionable number.
import { LISTING_BUDGET_CHARS, listingBudget } from "./content.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string): string => c(1, s);
const dim = (s: string): string => c(2, s);
const red = (s: string): string => c(31, s);
const green = (s: string): string => c(32, s);
const yellow = (s: string): string => c(33, s);
const cyan = (s: string): string => c(36, s);

const day = (iso?: string): string => (iso ? iso.slice(0, 10) : "unknown");

const SEV_COLOR: Record<string, (s: string) => string> = {
  critical: (s) => c(41, c(97, ` ${s} `)),
  high: red,
  medium: yellow,
  low: dim,
};

function printFinding(f: SecurityFinding): void {
  const sev = (SEV_COLOR[f.severity] ?? dim)(f.severity.toUpperCase());
  const conf = dim(`${f.confidence}`);
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  const also = f.alsoInFiles ? dim(` (same finding in ${f.alsoInFiles} more file${f.alsoInFiles > 1 ? "s" : ""})`) : "";
  console.log(`  ${sev} ${conf}  ${bold(f.skill)} ${dim(loc)} [${f.check}]${also}`);
  console.log(`        ${f.message}`);
  console.log(`        ${dim("evidence:")} ${f.evidence}`);
  // Every flag is meant to be verified at its source before anyone acts on it,
  // so the line printed here is the one to open — not a fragment to be joined
  // against the asset list by hand.
  if (f.path) console.log(`        ${dim("verify:")} ${f.path}${f.line ? `:${f.line}` : ""}`);
}

const KIND_LABEL: Record<AssetKind, [string, string]> = {
  skill: ["skill", "skills"],
  agent: ["agent", "agents"],
  command: ["command", "commands"],
  prompt: ["prompt", "prompts"],
  rule: ["rule", "rules"],
  instructions: ["instruction file", "instruction files"],
};

function countsLabel(s: SourceAudit): string {
  const counts = new Map<AssetKind, number>();
  for (const a of s.assets) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${KIND_LABEL[kind][n === 1 ? 0 : 1]}`)
    .join(" · ");
}

/** Which sources Claude's skill-listing budget applies to. */
const hasListingBudget = (s: SourceAudit): boolean =>
  (s.source === "claude" || s.source === "custom") && s.content.listingChars > 0;

/**
 * Did the scan actually look through a window? A history that observed NOTHING
 * is the same claim as no history at all, and must read as one. Cursor made
 * this visible: its adapter always returns a HistoryFacts (degraded reads still
 * report their reason), so a machine with no conversation store printed "from 0
 * local transcript file(s), unknown → unknown" followed by "0 of 0 never fired"
 * — a window nobody observed, stated as though it had been.
 *
 * The transcript window and the durable ledger are separate observations, and
 * either can be empty while the other says something: a provider whose
 * transcripts are gone still reports its lifetime figures. Both predicates live
 * here because the per-source block and the closing summary have to agree about
 * what was observed — they disagreed, and the summary was the one making a
 * window claim with no window behind it.
 */
const observedWindow = (h?: HistoryFacts): boolean =>
  !!h && (h.transcriptFiles > 0 || h.windowStart !== undefined || h.usage.length > 0);

/** A ledger with nothing in it yet is not an observation either. */
const observedLedger = (lt?: SourceLifetime): boolean =>
  !!lt && (lt.fired.length > 0 || lt.typedSince !== undefined);

// --- lifetime (durable ledger) ---------------------------------------------
// Window figures come from the transcripts the harness still keeps; lifetime
// figures come from the ledger that outlives them. The two are computed and
// printed side by side, each with its own qualifier, never conflated.

/** One asset's fires since tracking began. */
export interface LifetimeUsage {
  kind: AssetKind;
  name: string;
  invocations: number;
  sessions: number;
  firstFired: string;
  lastFired: string;
}

export interface SourceLifetime {
  /** ISO-8601 — the qualifier on every figure in this block. */
  trackedSince: string;
  /** Oldest backfilled event — typed-channel history reaches back this far. */
  typedSince?: string;
  /** Fired since trackedSince, most-invoked first. */
  fired: LifetimeUsage[];
  /** Dispatch-tracked assets with zero fires in the ledger AND the window. */
  neverFired: string[];
  /**
   * Always-injected chars of the neverFired assets — what every session pays
   * for items that have never fired. Reconstructed from the chars/4 token
   * figures, so it can differ from the true sum by a few chars per asset and
   * is labeled an estimate wherever it is printed.
   */
  deadWeightEstChars: number;
}

export type LifetimeBySource = Partial<Record<SourceId, SourceLifetime>>;

/**
 * Join ledger events onto each source's dispatch-tracked assets, keyed
 * (provider, kind, name). `events` must be ts-sorted ascending, which is how
 * Ledger.readEvents returns them. Lives beside the printers that consume it
 * so the formula and the display cannot drift apart.
 */
export function buildLifetime(
  sources: SourceAudit[],
  events: LedgerEvent[],
  trackedSince: string
): LifetimeBySource {
  // Join-time kind authority, mirroring buildUiPayload's rule: hook writers
  // hard-code provisional kinds and older banked events carry guesses, so
  // claude dispatch events are re-keyed through the audited assets' kinds
  // before joining — the channel is the evidence, and a name installed under
  // exactly one kind takes all of its fires.
  const claudeKinds = new Map<string, Set<AssetKind>>();
  for (const s of sources) {
    if (s.source !== "claude" && s.source !== "custom") continue;
    for (const a of s.assets) {
      if (a.kind !== "skill" && a.kind !== "command") continue;
      const set = claudeKinds.get(a.name);
      if (set) set.add(a.kind);
      else claudeKinds.set(a.name, new Set([a.kind]));
    }
  }
  const rekeyedKind = (e: LedgerEvent): AssetKind => {
    if (e.provider !== "claude" || e.channel === "load") return e.kind;
    if (e.kind !== "skill" && e.kind !== "command") return e.kind;
    const channelKind: AssetKind = e.channel === "typed" ? "command" : "skill";
    const set = claudeKinds.get(e.name);
    if (!set) return e.kind;
    if (set.has(channelKind)) return channelKind;
    return set.size === 1 ? [...set][0] : channelKind;
  };

  const byKey = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    const k = `${e.provider}\0${rekeyedKind(e)}\0${e.name}`;
    const list = byKey.get(k);
    if (list) list.push(e);
    else byKey.set(k, [e]);
  }

  const out: LifetimeBySource = {};
  for (const s of sources) {
    if (!s.history) continue;
    // A custom-directory audit reads Claude transcripts, and its banked
    // events carry provider "claude" — the join must use the same key.
    const provider = s.source === "custom" ? "claude" : s.source;
    const windowFired = new Set(s.history.usage.map((u) => u.skill));
    // Only kinds the window scan tracks: attaching ledger events to anything
    // else would grow the neverFired denominator behind the reader's back.
    const tracked = new Set([...windowFired, ...s.history.neverFired]);
    const descEst = new Map(s.content.tokens.map((t) => [t.skill, t.descriptionEst]));

    const fired: LifetimeUsage[] = [];
    const neverFired: string[] = [];
    let deadChars = 0;
    const seen = new Set<string>();
    for (const a of s.assets) {
      if (!tracked.has(a.name)) continue;
      // User+project copies merge by dispatch name, like the window figures.
      const key = `${a.kind}\0${a.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const evts = byKey.get(`${provider}\0${a.kind}\0${a.name}`) ?? [];
      if (evts.length > 0) {
        fired.push({
          kind: a.kind,
          name: a.name,
          invocations: evts.length,
          sessions: new Set(evts.map((e) => e.sessionId)).size,
          firstFired: evts[0].ts,
          lastFired: evts[evts.length - 1].ts,
        });
      } else if (!windowFired.has(a.name)) {
        if (!neverFired.includes(a.name)) neverFired.push(a.name);
        // Injection model per tracked kind: prompts pay their name only;
        // skills and commands pay name + description.
        deadChars += a.name.length + (a.kind === "prompt" ? 0 : (descEst.get(a.name) ?? 0) * 4);
      }
    }
    fired.sort((x, y) => y.invocations - x.invocations || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    neverFired.sort();
    const typedSince = events.find((e) => e.backfill === true && e.provider === provider)?.ts;
    const lt: SourceLifetime = { trackedSince, fired, neverFired, deadWeightEstChars: deadChars };
    if (typedSince) lt.typedSince = typedSince;
    out[s.source] = lt;
  }
  return out;
}

/** --json stays additive: each source gains an optional `lifetime` key, nothing else moves. */
export const withLifetime = (result: MultiAuditResult, lifetime?: LifetimeBySource): object =>
  lifetime ? { sources: result.sources.map((s) => ({ ...s, lifetime: lifetime[s.source] })) } : result;

function printSource(s: SourceAudit, lt?: SourceLifetime): void {
  const { content, security, history } = s;

  console.log();
  console.log(bold(`━━ ${s.source} `) + dim(`— ${countsLabel(s)}`));
  // Printed before the figures, not after: a qualifier that arrives once the
  // reader has already believed the number is not a qualifier.
  for (const caveat of s.caveats ?? []) console.log(`  ${yellow("caveat:")} ${caveat}`);

  // ---- Cost ----
  // Deliberately first. What rides along in every session is the fact most
  // likely to explain what the user came here about; the security gauntlet is
  // below it, not above it.
  console.log();
  console.log(bold(cyan("COST")));
  console.log(
    `  always in context: ${bold(`${content.alwaysInjectedChars.toLocaleString()} chars`)} ${dim(`(~${content.alwaysInjectedEst.toLocaleString()} tokens)`)}`
  );
  let overBudget = false;
  if (hasListingBudget(s)) {
    const b = listingBudget(content.listingChars);
    const pct = b.pct;
    overBudget = b.over;
    if (overBudget) {
      console.log(
        `  ${red(`skill listing at ${pct}% of the ~${LISTING_BUDGET_CHARS.toLocaleString()}-char budget`)} — over it, Claude Code drops`
      );
      console.log(`  descriptions starting with the skills you invoke least. Those skills stay`);
      console.log(`  installed but stop auto-triggering. ${dim("Raise it with skillListingBudgetFraction.")}`);
    } else {
      console.log(
        `  ${green(`skill listing at ${pct}% of the ~${LISTING_BUDGET_CHARS.toLocaleString()}-char budget`)} ${dim("— under it, all descriptions load")}`
      );
    }
  }
  console.log(`  total body size if all invoked: ~${content.totalBodyEst.toLocaleString()} tokens`);
  const biggest = content.tokens.slice(0, 5);
  if (biggest.length > 0) {
    console.log(`  largest bodies: ${biggest.map((t) => `${t.skill} (~${t.bodyEst.toLocaleString()})`).join(", ")}`);
  }

  // ---- Dispatch ----
  // Only meaningful where something auto-dispatches on a description.
  const dispatchKinds = s.assets.some((a) => a.kind === "skill" || a.kind === "agent" || a.kind === "command");
  if (dispatchKinds) {
    console.log();
    console.log(bold(cyan("DISPATCH")));
    let dispatchIssues = 0;
    if (content.emptyDescriptions.length > 0) {
      dispatchIssues++;
      console.log(`  ${yellow(`${content.emptyDescriptions.length} empty description(s)`)}: ${content.emptyDescriptions.join(", ")}`);
    }
    dispatchIssues += content.duplicateDescriptions.length + content.nameMismatches.length;
    if (content.missingSkillMd.length > 0) dispatchIssues++;
    for (const d of content.duplicateDescriptions) {
      console.log(`  ${yellow("identical descriptions")}: ${d.skills.join(", ")}`);
      const flat = d.description.replace(/\s+/g, " ");
      console.log(`        ${dim(`"${flat.slice(0, 90)}${flat.length > 90 ? "…" : ""}"`)}`);
    }
    for (const m of content.nameMismatches) {
      console.log(`  ${yellow("name mismatch")}: directory ${bold(m.skill)} vs frontmatter ${bold(m.fmName)}`);
    }
    if (content.missingSkillMd.length > 0) {
      console.log(`  ${yellow("no SKILL.md")}: ${content.missingSkillMd.join(", ")}`);
    }
    if (dispatchIssues === 0) {
      console.log(`  ${green("no collisions, empty descriptions, or name mismatches")}`);
    }
  }

  // ---- Usage ----
  console.log();
  console.log(bold(cyan("USAGE")));
  const sawWindow = observedWindow(history);
  if (!history || (!sawWindow && !observedLedger(lt))) {
    console.log(dim(`  no usage data — ${s.source} keeps no transcripts this tool can read (or the scan was skipped)`));
  } else {
    // Only where a window was actually observed: "0 files, unknown → unknown"
    // states a window nobody looked through.
    if (sawWindow) {
      console.log(
        dim(
          `  from ${history.transcriptFiles} local transcript file(s), ${day(history.windowStart)} → ${day(history.windowEnd)}`
        )
      );
    }
    if (lt) {
      const typed =
        lt.typedSince && lt.typedSince < lt.trackedSince
          ? `; typed-channel history extends to ${day(lt.typedSince)} (backfilled)`
          : "";
      console.log(dim(`  durable ledger: tracking since ${day(lt.trackedSince)}${typed}`));
    }
    // Ledger tail for a window line. "0 since <date>" is a claim ("tracked
    // that long, never seen"), so it only appears when a ledger was read.
    const lifetimeTail = (name: string): string => {
      if (!lt) return "";
      let n = 0;
      let since = lt.trackedSince;
      for (const u of lt.fired) {
        if (u.name !== name) continue;
        n += u.invocations;
        if (u.firstFired < since) since = u.firstFired;
      }
      return dim(` · ${n} since ${day(since)}`);
    };
    const tracked = history.usage.length + history.neverFired.length;
    // The drop order is by least-invoked, so a never-fired asset is both the
    // first to lose its description and the least able to earn it back.
    const firstInLine = `  ${yellow("these are first in line")} to lose their descriptions while you are over budget`;
    // "in this window" is sayable only where a window was actually observed.
    // A machine whose transcripts are gone but whose ledger is not returns
    // transcriptFiles 0, no windowStart, and every tracked asset in
    // neverFired — a fully populated denominator with no window behind it,
    // which printed "2 of 2 never fired in this window" against a span nobody
    // looked through. The count is not suppressed; it is stated below against
    // the qualifier it actually has (tracking-since), which is the only
    // observation there is in that case.
    if (sawWindow) {
      console.log(
        `  ${bold(`${history.neverFired.length} of ${tracked}`)} never fired in this window ${history.usage.length > 0 ? dim(`(${history.usage.length} fired)`) : ""}`
      );
      if (history.neverFired.length > 0) {
        console.log(`        ${dim(history.neverFired.join(", "))}`);
        if (overBudget) console.log(firstInLine);
      }
    }
    if (lt && lt.neverFired.length > 0) {
      // "of those" points back at the window line; without one it points at
      // nothing, so the denominator is named outright.
      const of = sawWindow ? "of those" : `of ${tracked}`;
      console.log(
        `  dead weight: ${bold(String(lt.neverFired.length))} ${of} never fired since tracking began ${day(lt.trackedSince)} — ` +
          `~${lt.deadWeightEstChars.toLocaleString()} chars always in context ${dim(`(~${Math.ceil(lt.deadWeightEstChars / 4).toLocaleString()} tokens, chars/4 estimate)`)}`
      );
      if (!sawWindow) {
        console.log(`        ${dim(lt.neverFired.join(", "))}`);
        if (overBudget) console.log(firstInLine);
      }
    }
    const top = history.usage.slice(0, 10);
    if (top.length > 0) {
      console.log(`  most fired:`);
      for (const u of top) {
        const interrupted =
          u.interruptedAfter > 0 ? yellow(` — interrupted after ${u.interruptedAfter}/${u.invocations}`) : "";
        console.log(
          `        ${bold(u.skill)} × ${u.invocations} in ${u.sessions} session(s), last ${day(u.lastFired)}${lifetimeTail(u.skill)}${interrupted}`
        );
      }
    }
    for (const u of history.usage.filter((u) => u.interruptedAfter > 0 && !top.includes(u))) {
      console.log(
        `        ${bold(u.skill)} ${yellow(`interrupted after ${u.interruptedAfter}/${u.invocations} invocation(s)`)}`
      );
    }
    if (lt) {
      // Fired historically, silent in the current window — invisible to the
      // window figures, and exactly the rows a "did my skill die?" reader needs.
      const windowFired = new Set(history.usage.map((w) => w.skill));
      const quiet = lt.fired.filter((u) => !windowFired.has(u.name));
      if (quiet.length > 0) {
        // Same rule as the never-fired figure above: with no window observed
        // these are not "before the window" — there is no window for them to
        // be outside of, and the header says which observation they come from.
        console.log(
          sawWindow ? `  fired before this window, 0 in it:` : `  ledger fires (no transcript window to compare):`
        );
        for (const u of quiet.slice(0, 10)) {
          const since = u.firstFired < lt.trackedSince ? u.firstFired : lt.trackedSince;
          console.log(`        ${bold(u.name)} × ${u.invocations} since ${day(since)}, last ${day(u.lastFired)}`);
        }
        if (quiet.length > 10) console.log(dim(`        + ${quiet.length - 10} more`));
      }
    }
  }

  // ---- Security ----
  const flags = security.filter((f) => f.level === "flag");
  const infos = security.filter((f) => f.level === "info");
  console.log();
  console.log(bold(cyan("SECURITY")));
  if (flags.length === 0) {
    console.log(`  ${green("no flagged findings")} ${dim(`(${infos.length} informational)`)}`);
  } else {
    for (const f of flags) printFinding(f);
    console.log(dim(`  + ${infos.length} informational finding(s) — run with --json for all`));
  }
}

export function printReport(result: MultiAuditResult, lifetime?: LifetimeBySource): void {
  const { sources } = result;
  console.log();
  console.log(
    bold(`context-audit — ${sources.length} source${sources.length === 1 ? "" : "s"}: `) +
      sources.map((s) => s.source).join(", ")
  );

  for (const s of sources) printSource(s, lifetime?.[s.source]);

  console.log();
  console.log(dim("  static analysis catches commodity attacks; encrypted/staged payloads and"));
  console.log(dim("  plain-English instructions can evade it. A clean scan is not a guarantee."));

  // ---- Cross-source summary ----
  const flags = sources.flatMap((s) => s.security.filter((f) => f.level === "flag"));
  // Each source contributes the count that has an observation behind it: the
  // window's never-fired list where a window was observed, the LEDGER's where
  // only a ledger was. Summing the window list unconditionally printed "2
  // asset(s) never fired" on a machine with no transcripts at all — counting a
  // skill the ledger holds fires for, under a window nobody looked through.
  // With neither observation the clause is dropped: the block above already
  // said "no usage data", and a headline is the last place to invent one.
  const neverFired = sources.reduce((n, s) => {
    if (observedWindow(s.history)) return n + (s.history?.neverFired.length ?? 0);
    const lt = lifetime?.[s.source];
    return n + (observedLedger(lt) ? lt!.neverFired.length : 0);
  }, 0);
  const anyHistory = sources.some((s) => observedWindow(s.history) || observedLedger(lifetime?.[s.source]));
  const overBudget = sources.some(
    (s) => hasListingBudget(s) && s.content.listingChars > LISTING_BUDGET_CHARS
  );
  console.log();
  const summary = flags.length > 0 ? red(`${flags.length} security flag(s)`) : green("0 security flags");
  const cost = overBudget ? red("listing over budget") : green("listing within budget");
  const dead = anyHistory ? ` · ${neverFired} asset(s) never fired` : "";
  // Cost and dead weight first, security last. That is the order of how often
  // each one is actionable: nearly every run has assets that never fired, and
  // most runs have no security flag at all.
  console.log(`${bold("result:")} ${cost}${dead} · ${summary}`);
  console.log(dim("facts only — deciding what to do with them is your (or your model's) job"));
  console.log();
}

export function printJson(result: object): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Token-efficient output for AI agents: flags in full (they need verification),
 * info findings aggregated to counts, tables trimmed. An agent should be able to
 * act on this without paying for 200+ informational entries.
 */
export function printAgent(result: MultiAuditResult, lifetime?: LifetimeBySource): void {
  const sources = result.sources.map((s) => {
    const flags = s.security.filter((f) => f.level === "flag");
    const infoByCheck: Record<string, number> = {};
    for (const f of s.security) {
      if (f.level === "info") infoByCheck[f.check] = (infoByCheck[f.check] ?? 0) + 1;
    }
    const assetCounts: Record<string, number> = {};
    for (const a of s.assets) assetCounts[a.kind] = (assetCounts[a.kind] ?? 0) + 1;
    return {
      source: s.source,
      assetCounts,
      // The agent relays these figures to the user, so a qualifier that only
      // reached the human-readable report would be dropped exactly where it
      // matters most.
      caveats: s.caveats,
      security: { flags, infoCounts: infoByCheck },
      content: {
        alwaysInjectedChars: s.content.alwaysInjectedChars,
        alwaysInjectedEstTokens: s.content.alwaysInjectedEst,
        listingChars: s.content.listingChars,
        totalBodyEstTokens: s.content.totalBodyEst,
        emptyDescriptions: s.content.emptyDescriptions,
        duplicateDescriptions: s.content.duplicateDescriptions,
        nameMismatches: s.content.nameMismatches,
        missingSkillMd: s.content.missingSkillMd,
        largestBodies: s.content.tokens.slice(0, 10),
      },
      usage: s.history
        ? {
            window: `${s.history.windowStart ?? "?"} → ${s.history.windowEnd ?? "?"}`,
            transcriptFiles: s.history.transcriptFiles,
            neverFired: s.history.neverFired,
            fired: s.history.usage,
            // The agent relays these too — trackedSince travels with the block
            // so a lifetime figure is never repeated without its qualifier.
            lifetime: lifetime?.[s.source],
          }
        : undefined,
    };
  });
  const anyFlags = sources.some((s) => s.security.flags.length > 0);
  console.log(
    JSON.stringify(
      {
        sources,
        note: "Verify each flag by opening its `path` at `line` before alarming the user — `path` is absolute and is the file this finding is about; `file` alone is relative to the asset and is not what you should open. Full detail: --json",
        exitCode: anyFlags ? 1 : 0,
      },
      null,
      1
    )
  );
}
