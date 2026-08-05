import type { ContentFacts, ListingBudget, Skill } from "./types.js";

const est = (s: string): number => Math.ceil(s.length / 4);

/**
 * Claude Code loads skill names + descriptions into every session under a
 * character budget of `skillListingBudgetFraction` (default 1% of the context
 * window — 8,000 chars on a 200K model). Past it, descriptions are dropped
 * starting with the least-invoked skills; the skill still exists but can no
 * longer auto-trigger. Documented at code.claude.com/docs/en/skills.
 *
 * This is the tool's most actionable number — it is the answer to "why has
 * Claude stopped firing my skill?" — so it lives here rather than in either
 * renderer: the report and the dashboard must never disagree about it.
 */
export const LISTING_BUDGET_CHARS = 8000;

/** The listing figure and what it means, computed once for every surface. */
export function listingBudget(chars: number): ListingBudget {
  return {
    chars,
    budgetChars: LISTING_BUDGET_CHARS,
    // Rounded for display only; `over` is decided on the raw characters, so a
    // listing at 100.4% never reads "100%" next to the word "within".
    pct: Math.round((chars / LISTING_BUDGET_CHARS) * 100),
    over: chars > LISTING_BUDGET_CHARS,
  };
}

/**
 * Characters this asset contributes to the skill listing. Only skills are
 * listed under the budget, and only while they are loaded — a disabled skill
 * costs nothing because it is not in the directory Claude Code reads.
 */
export function listingChars(asset: Skill): number {
  if ((asset.kind ?? "skill") !== "skill" || !asset.hasSkillMd) return 0;
  return asset.dirName.length + (asset.description?.trim().length ?? 0);
}

/**
 * Characters an asset keeps in context at all times, per its Injection model.
 * An undefined injection is the original claude-skill shape: name + description.
 * Exported so the ui payload prices items with the same model as the report —
 * two cost formulas for one number is how a dashboard contradicts its own CLI.
 */
export function injectedChars(asset: Skill): number {
  switch (asset.injection ?? "description") {
    case "body":
      return asset.dirName.length + asset.body.length;
    case "description":
      return asset.dirName.length + (asset.description?.trim().length ?? 0);
    case "name-only":
      return asset.dirName.length;
    case "on-demand":
      return 0;
  }
}

export function contentFacts(assets: Skill[]): ContentFacts {
  const emptyDescriptions: string[] = [];
  const nameMismatches: { skill: string; fmName: string }[] = [];
  const missingSkillMd: string[] = [];
  const byDescription = new Map<string, string[]>();
  const tokens: ContentFacts["tokens"] = [];
  let alwaysInjectedChars = 0;
  let listed = 0;

  for (const asset of assets) {
    const kind = asset.kind ?? "skill";
    if (!asset.hasSkillMd) {
      missingSkillMd.push(asset.dirName);
      continue;
    }
    alwaysInjectedChars += injectedChars(asset);
    listed += listingChars(asset);
    const desc = asset.description?.trim() ?? "";
    if (desc === "") {
      // Only kinds that auto-dispatch on their description are broken without
      // one. A command is user-invoked and an instruction file has no
      // description at all — calling those "empty" would be noise. An agent
      // file with NO frontmatter whatsoever (a README sitting in agents/) is
      // documentation, not a broken agent — it stays security-scanned but is
      // not a dispatch finding.
      const declared = kind === "skill" || asset.fmName !== undefined || asset.description !== undefined;
      if ((kind === "skill" || kind === "agent") && declared) emptyDescriptions.push(asset.dirName);
    } else {
      const key = desc.toLowerCase().replace(/\s+/g, " ");
      byDescription.set(key, [...(byDescription.get(key) ?? []), asset.dirName]);
    }
    // Directory-vs-frontmatter drift only exists where the directory IS the
    // dispatch name; file-based kinds take their name from the file or `name:`.
    if (kind === "skill" && asset.fmName && asset.fmName !== asset.dirName) {
      nameMismatches.push({ skill: asset.dirName, fmName: asset.fmName });
    }
    tokens.push({ skill: asset.dirName, bodyEst: est(asset.body), descriptionEst: est(desc) });
  }

  const duplicateDescriptions = [...byDescription.values()]
    .filter((names) => names.length > 1)
    .map((names) => {
      const first = assets.find((s) => s.dirName === names[0]);
      return { description: first?.description?.trim() ?? "", skills: names };
    });

  tokens.sort((a, b) => b.bodyEst - a.bodyEst);

  return {
    skillCount: assets.length,
    emptyDescriptions,
    duplicateDescriptions,
    nameMismatches,
    missingSkillMd,
    tokens,
    totalBodyEst: tokens.reduce((sum, t) => sum + t.bodyEst, 0),
    alwaysInjectedEst: Math.ceil(alwaysInjectedChars / 4),
    alwaysInjectedChars,
    listingChars: listed,
  };
}
