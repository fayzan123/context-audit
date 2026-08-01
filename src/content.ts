import type { ContentFacts, Skill } from "./types.js";

const est = (s: string): number => Math.ceil(s.length / 4);

/**
 * Characters an asset keeps in context at all times, per its Injection model.
 * An undefined injection is the original claude-skill shape: name + description.
 */
function injectedChars(asset: Skill): number {
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
  let listingChars = 0;

  for (const asset of assets) {
    const kind = asset.kind ?? "skill";
    if (!asset.hasSkillMd) {
      missingSkillMd.push(asset.dirName);
      continue;
    }
    alwaysInjectedChars += injectedChars(asset);
    if (kind === "skill") {
      listingChars += asset.dirName.length + (asset.description?.trim().length ?? 0);
    }
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
    listingChars,
  };
}
