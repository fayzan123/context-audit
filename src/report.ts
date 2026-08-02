import type { AssetKind, MultiAuditResult, SecurityFinding, SourceAudit } from "./types.js";

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

/**
 * Claude Code loads skill names + descriptions into every session under a
 * character budget of `skillListingBudgetFraction` (default 1% of the context
 * window — 8,000 chars on a 200K model). Past it, descriptions are dropped
 * starting with the least-invoked skills; the skill still exists but can no
 * longer auto-trigger. Documented at code.claude.com/docs/en/skills.
 * This budget is Claude-specific, so it is only compared for claude sources.
 */
const LISTING_BUDGET_CHARS = 8000;

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

function printSource(s: SourceAudit): void {
  const { content, security, history } = s;

  console.log();
  console.log(bold(`━━ ${s.source} `) + dim(`— ${countsLabel(s)}`));

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
    const chars = content.listingChars;
    const pct = Math.round((chars / LISTING_BUDGET_CHARS) * 100);
    overBudget = chars > LISTING_BUDGET_CHARS;
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
  if (!history) {
    console.log(dim(`  no usage data — ${s.source} keeps no transcripts this tool can read (or the scan was skipped)`));
  } else {
    console.log(
      dim(
        `  from ${history.transcriptFiles} local transcript file(s), ${day(history.windowStart)} → ${day(history.windowEnd)}`
      )
    );
    const tracked = history.usage.length + history.neverFired.length;
    console.log(
      `  ${bold(`${history.neverFired.length} of ${tracked}`)} never fired in this window ${history.usage.length > 0 ? dim(`(${history.usage.length} fired)`) : ""}`
    );
    if (history.neverFired.length > 0) {
      console.log(`        ${dim(history.neverFired.join(", "))}`);
      // The drop order is by least-invoked, so a never-fired skill is both the
      // first to lose its description and the least able to earn it back.
      if (overBudget) {
        console.log(`  ${yellow("these are first in line")} to lose their descriptions while you are over budget`);
      }
    }
    const top = history.usage.slice(0, 10);
    if (top.length > 0) {
      console.log(`  most fired:`);
      for (const u of top) {
        const interrupted =
          u.interruptedAfter > 0 ? yellow(` — interrupted after ${u.interruptedAfter}/${u.invocations}`) : "";
        console.log(
          `        ${bold(u.skill)} × ${u.invocations} in ${u.sessions} session(s), last ${day(u.lastFired)}${interrupted}`
        );
      }
    }
    for (const u of history.usage.filter((u) => u.interruptedAfter > 0 && !top.includes(u))) {
      console.log(
        `        ${bold(u.skill)} ${yellow(`interrupted after ${u.interruptedAfter}/${u.invocations} invocation(s)`)}`
      );
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

export function printReport(result: MultiAuditResult): void {
  const { sources } = result;
  console.log();
  console.log(
    bold(`context-audit — ${sources.length} source${sources.length === 1 ? "" : "s"}: `) +
      sources.map((s) => s.source).join(", ")
  );

  for (const s of sources) printSource(s);

  console.log();
  console.log(dim("  static analysis catches commodity attacks; encrypted/staged payloads and"));
  console.log(dim("  plain-English instructions can evade it. A clean scan is not a guarantee."));

  // ---- Cross-source summary ----
  const flags = sources.flatMap((s) => s.security.filter((f) => f.level === "flag"));
  const neverFired = sources.reduce((n, s) => n + (s.history?.neverFired.length ?? 0), 0);
  const anyHistory = sources.some((s) => s.history);
  const overBudget = sources.some(
    (s) => hasListingBudget(s) && s.content.listingChars > LISTING_BUDGET_CHARS
  );
  console.log();
  const summary = flags.length > 0 ? red(`${flags.length} security flag(s)`) : green("0 security flags");
  const cost = overBudget ? red("listing over budget") : green("listing within budget");
  const dead = anyHistory ? ` · ${neverFired} asset(s) never fired` : "";
  console.log(`${bold("result:")} ${cost} · ${summary}${dead}`);
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
export function printAgent(result: MultiAuditResult): void {
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
