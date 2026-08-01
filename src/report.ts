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

function printFinding(f: SecurityFinding): void {
  const tag = f.level === "flag" ? red("FLAG") : dim("info");
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  console.log(`  ${tag}  ${bold(f.skill)} ${dim(loc)} [${f.check}]`);
  console.log(`        ${f.message}`);
  console.log(`        ${dim("evidence:")} ${f.evidence}`);
}

export function printReport(result: AuditResult): void {
  const { content, security, history } = result;

  console.log();
  console.log(bold(`skill-audit — ${result.dir}`));
  console.log(dim(`${content.skillCount} skills scanned`));

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

  // ---- Content ----
  console.log();
  console.log(bold(cyan("CONTENT")));
  console.log(
    `  always injected (names + descriptions): ${bold(`~${content.alwaysInjectedEst.toLocaleString()} tokens`)} ${dim("(chars/4 estimate)")}`
  );
  console.log(
    `  total body size if all invoked: ~${content.totalBodyEst.toLocaleString()} tokens`
  );
  if (content.emptyDescriptions.length > 0) {
    console.log(`  ${yellow(`${content.emptyDescriptions.length} empty description(s)`)}: ${content.emptyDescriptions.join(", ")}`);
  }
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
  const biggest = content.tokens.slice(0, 5);
  if (biggest.length > 0) {
    console.log(`  largest bodies: ${biggest.map((t) => `${t.skill} (~${t.bodyEst.toLocaleString()})`).join(", ")}`);
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

  console.log();
  const summary =
    flags.length > 0
      ? red(`${flags.length} security flag(s)`)
      : green("0 security flags");
  console.log(`${bold("result:")} ${summary}${dim(" · facts only — deciding what to do with them is your (or your model's) job")}`);
  console.log();
}

export function printJson(result: AuditResult): void {
  console.log(JSON.stringify(result, null, 2));
}
