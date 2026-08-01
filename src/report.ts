import type { AuditResult, SecurityFinding } from "./types.js";

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
}

/**
 * Claude Code loads skill names + descriptions into every session under a
 * character budget of `skillListingBudgetFraction` (default 1% of the context
 * window — 8,000 chars on a 200K model). Past it, descriptions are dropped
 * starting with the least-invoked skills; the skill still exists but can no
 * longer auto-trigger. Documented at code.claude.com/docs/en/skills.
 */
const LISTING_BUDGET_CHARS = 8000;

export function printReport(result: AuditResult): void {
  const { content, security, history } = result;

  console.log();
  console.log(bold(`skill-audit — ${result.dir}`));
  console.log(dim(`${content.skillCount} skills scanned`));

  // ---- Cost ----
  // Deliberately first. The listing budget decides whether a skill can fire at
  // all, which makes it the fact most likely to explain what the user came here
  // about; the security gauntlet is below it, not above it.
  console.log();
  console.log(bold(cyan("COST")));
  const chars = content.alwaysInjectedChars;
  const pct = Math.round((chars / LISTING_BUDGET_CHARS) * 100);
  const over = chars > LISTING_BUDGET_CHARS;
  console.log(
    `  always injected (names + descriptions): ${bold(`${chars.toLocaleString()} chars`)} ${dim(`(~${content.alwaysInjectedEst.toLocaleString()} tokens)`)}`
  );
  if (over) {
    console.log(
      `  ${red(`${pct}% of the ~${LISTING_BUDGET_CHARS.toLocaleString()}-char skill-listing budget`)} — over it, Claude Code drops`
    );
    console.log(
      `  descriptions starting with the skills you invoke least. Those skills stay`
    );
    console.log(`  installed but stop auto-triggering. ${dim("Raise it with skillListingBudgetFraction.")}`);
  } else {
    console.log(
      `  ${green(`${pct}% of the ~${LISTING_BUDGET_CHARS.toLocaleString()}-char skill-listing budget`)} ${dim("— under it, all descriptions load")}`
    );
  }
  console.log(
    `  total body size if all invoked: ~${content.totalBodyEst.toLocaleString()} tokens`
  );
  const biggest = content.tokens.slice(0, 5);
  if (biggest.length > 0) {
    console.log(`  largest bodies: ${biggest.map((t) => `${t.skill} (~${t.bodyEst.toLocaleString()})`).join(", ")}`);
  }

  // ---- Dispatch ----
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

  // ---- Usage ----
  if (history) {
    console.log();
    console.log(bold(cyan("USAGE")));
    console.log(
      dim(
        `  from ${history.transcriptFiles} local transcript file(s), ${day(history.windowStart)} → ${day(history.windowEnd)}`
      )
    );
    const fired = history.usage.length;
    console.log(
      `  ${bold(`${history.neverFired.length} of ${content.skillCount}`)} skills never fired in this window ${fired > 0 ? dim(`(${fired} fired)`) : ""}`
    );
    if (history.neverFired.length > 0) {
      console.log(`        ${dim(history.neverFired.join(", "))}`);
      // The drop order is by least-invoked, so a never-fired skill is both the
      // first to lose its description and the least able to earn it back.
      if (over) {
        console.log(
          `  ${yellow("these are first in line")} to lose their descriptions while you are over budget`
        );
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
    const interruptedNotTop = history.usage.filter(
      (u) => u.interruptedAfter > 0 && !top.includes(u)
    );
    for (const u of interruptedNotTop) {
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
  console.log(dim("  static analysis catches commodity attacks; encrypted/staged payloads and"));
  console.log(dim("  plain-English instructions can evade it. A clean scan is not a guarantee."));

  console.log();
  const summary =
    flags.length > 0
      ? red(`${flags.length} security flag(s)`)
      : green("0 security flags");
  const cost = over ? red(`listing ${pct}% over budget`) : green("listing within budget");
  const dead = history ? ` · ${history.neverFired.length} skill(s) never fired` : "";
  console.log(`${bold("result:")} ${cost} · ${summary}${dead}`);
  console.log(dim("facts only — deciding what to do with them is your (or your model's) job"));
  console.log();
}

export function printJson(result: AuditResult): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Token-efficient output for AI agents: flags in full (they need verification),
 * info findings aggregated to counts, tables trimmed. An agent should be able to
 * act on this without paying for 200+ informational entries.
 */
export function printAgent(result: AuditResult): void {
  const { content, security, history } = result;
  const flags = security.filter((f) => f.level === "flag");
  const infoByCheck: Record<string, number> = {};
  for (const f of security) {
    if (f.level === "info") infoByCheck[f.check] = (infoByCheck[f.check] ?? 0) + 1;
  }
  const out = {
    dir: result.dir,
    skillCount: content.skillCount,
    security: {
      flags,
      infoCounts: infoByCheck,
      note: "Verify each flag by reading the cited file:line before alarming the user. Full detail: --json",
    },
    content: {
      alwaysInjectedEstTokens: content.alwaysInjectedEst,
      totalBodyEstTokens: content.totalBodyEst,
      emptyDescriptions: content.emptyDescriptions,
      duplicateDescriptions: content.duplicateDescriptions,
      nameMismatches: content.nameMismatches,
      missingSkillMd: content.missingSkillMd,
      largestBodies: content.tokens.slice(0, 10),
    },
    usage: history
      ? {
          window: `${history.windowStart ?? "?"} → ${history.windowEnd ?? "?"}`,
          transcriptFiles: history.transcriptFiles,
          neverFired: history.neverFired,
          fired: history.usage,
        }
      : undefined,
    exitCode: flags.length > 0 ? 1 : 0,
  };
  console.log(JSON.stringify(out, null, 1));
}
