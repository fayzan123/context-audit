import type { ContentFacts, Skill } from "./types.js";

const est = (s: string): number => Math.ceil(s.length / 4);

export function contentFacts(skills: Skill[]): ContentFacts {
  const emptyDescriptions: string[] = [];
  const nameMismatches: { skill: string; fmName: string }[] = [];
  const missingSkillMd: string[] = [];
  const byDescription = new Map<string, string[]>();
  const tokens: ContentFacts["tokens"] = [];

  for (const skill of skills) {
    if (!skill.hasSkillMd) {
      missingSkillMd.push(skill.dirName);
      continue;
    }
    const desc = skill.description?.trim() ?? "";
    if (desc === "") emptyDescriptions.push(skill.dirName);
    else {
      const key = desc.toLowerCase().replace(/\s+/g, " ");
      byDescription.set(key, [...(byDescription.get(key) ?? []), skill.dirName]);
    }
    if (skill.fmName && skill.fmName !== skill.dirName) {
      nameMismatches.push({ skill: skill.dirName, fmName: skill.fmName });
    }
    tokens.push({ skill: skill.dirName, bodyEst: est(skill.body), descriptionEst: est(desc) });
  }

  const duplicateDescriptions = [...byDescription.values()]
    .filter((names) => names.length > 1)
    .map((names) => {
      const first = skills.find((s) => s.dirName === names[0]);
      return { description: first?.description?.trim() ?? "", skills: names };
    });

  tokens.sort((a, b) => b.bodyEst - a.bodyEst);

  return {
    skillCount: skills.length,
    emptyDescriptions,
    duplicateDescriptions,
    nameMismatches,
    missingSkillMd,
    tokens,
    totalBodyEst: tokens.reduce((sum, t) => sum + t.bodyEst, 0),
    alwaysInjectedEst: tokens.reduce(
      (sum, t) => sum + t.descriptionEst + est(t.skill),
      0
    ),
    // Characters, not the token estimate: the budget Claude Code enforces is
    // measured in characters, so comparing against it needs the real count.
    alwaysInjectedChars: skills.reduce(
      (sum, s) => sum + s.dirName.length + (s.description?.trim().length ?? 0),
      0
    ),
  };
}
