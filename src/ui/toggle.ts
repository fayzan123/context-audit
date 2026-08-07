import { lstatSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Existence of the NAME, not of what it points at. Skills directories are
 * commonly symlink farms — 24 of 37 on the machine this was built on — and
 * `existsSync` follows links: a broken link reads as absent, so the move would
 * be refused as "not on disk" at the source and would silently clobber the
 * link at the destination. `rename` operates on the name either way, so the
 * check has to as well.
 */
function nameExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enable/disable = a move between a directory Claude Code reads and a sibling
 * it does not. That is the whole mechanism: no state file to drift out of sync
 * with disk, git sees a rename, and a fresh CLI run agrees with the dashboard
 * for free.
 *
 * It works for skills (a DIRECTORY under ~/.claude/skills) and for agents (a
 * single .md FILE under ~/.claude/agents) without caring which, because
 * `rename` operates on a name either way.
 *
 * The sibling is what makes this safe. Claude Code resolves agents from
 * `.claude/agents/*.md` — its own tool documentation says so — and no glob
 * rooted at that directory can reach a sibling of it at any depth. v1 refused
 * agents on the grounds that it would have to invent a convention; it turned
 * out `skills-disabled` was never a Claude Code convention either, just a
 * directory Claude Code does not read, and the same reasoning carries over
 * unchanged.
 */
export interface TogglePair {
  /** The directory Claude Code reads: ~/.claude/skills, ~/.claude/agents. */
  enabledRoot: string;
  /** Its sibling, which Claude Code does not: ~/.claude/skills-disabled. */
  disabledRoot: string;
}

export type ToggleRoots = TogglePair | TogglePair[];

/** Every pair a toggle may be planned against, in a stable order. */
const pairsOf = (roots: ToggleRoots): TogglePair[] => (Array.isArray(roots) ? roots : [roots]);

export type TogglePlan =
  | { ok: true; action: "disable" | "enable"; from: string; to: string }
  | { ok: false; error: string };

/**
 * Decide what a toggle of `itemDir` would do, without touching disk. Refusals
 * live here so the tests can assert them without building fixture trees.
 */
export function planToggle(itemPath: string, roots: ToggleRoots): TogglePlan {
  const dir = resolve(itemPath);
  const name = basename(dir);
  const pairs = pairsOf(roots);
  // Only a DIRECT child of a user root is toggleable. Anything else — the
  // plugin cache, a project .claude/skills, a nested path inside a skill — has
  // no disable convention, and inventing one per case is how files get lost.
  for (const p of pairs) {
    if (dirname(dir) === resolve(p.enabledRoot)) {
      return { ok: true, action: "disable", from: dir, to: join(resolve(p.disabledRoot), name) };
    }
    if (dirname(dir) === resolve(p.disabledRoot)) {
      return { ok: true, action: "enable", from: dir, to: join(resolve(p.enabledRoot), name) };
    }
  }
  return {
    ok: false,
    error:
      `not a user-scoped Claude asset: ${dir} — only direct children of ` +
      pairs.map((p) => `${p.enabledRoot} and ${p.disabledRoot}`).join(", ") +
      ` can be toggled`,
  };
}

/**
 * Execute a planned toggle. Every refusal is a readable message, never a
 * silent no-op — the drawer renders exactly what comes back from here.
 */
export function performToggle(itemDir: string, roots: ToggleRoots): TogglePlan {
  const plan = planToggle(itemDir, roots);
  if (!plan.ok) return plan;
  if (!nameExists(plan.from)) {
    return { ok: false, error: `no longer on disk: ${plan.from} — rescan and retry` };
  }
  if (nameExists(plan.to)) {
    // Never overwrite: the same name on both sides is a real conflict (it
    // exists on the machine this was built on) and deciding which copy wins
    // is the user's call, not a rename's side effect.
    return {
      ok: false,
      error: `"${basename(plan.to)}" already exists at ${plan.to} — resolve the duplicate before toggling`,
    };
  }
  try {
    mkdirSync(dirname(plan.to), { recursive: true });
    renameSync(plan.from, plan.to);
  } catch (err: any) {
    const why = err?.code === "EACCES" || err?.code === "EPERM" ? "permission denied" : err?.message ?? String(err);
    return { ok: false, error: `could not move ${plan.from} → ${plan.to}: ${why}` };
  }
  return plan;
}
