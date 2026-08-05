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
 * Enable/disable = a directory move between skills/ and skills-disabled/.
 * That is the whole mechanism: no state file to drift out of sync with disk,
 * git sees a rename, and a fresh CLI run agrees with the dashboard for free.
 */
export interface ToggleRoots {
  /** ~/.claude/skills */
  enabledRoot: string;
  /** ~/.claude/skills-disabled */
  disabledRoot: string;
}

export type TogglePlan =
  | { ok: true; action: "disable" | "enable"; from: string; to: string }
  | { ok: false; error: string };

/**
 * Decide what a toggle of `itemDir` would do, without touching disk. Refusals
 * live here so the tests can assert them without building fixture trees.
 */
export function planToggle(itemDir: string, roots: ToggleRoots): TogglePlan {
  const dir = resolve(itemDir);
  const name = basename(dir);
  // Only a DIRECT child of the user skills roots is toggleable. Anything else
  // — plugin cache, project .claude/skills, a nested path inside a skill —
  // has no safe disable convention, and inventing one is how files get lost.
  if (dirname(dir) === resolve(roots.enabledRoot)) {
    return { ok: true, action: "disable", from: dir, to: join(resolve(roots.disabledRoot), name) };
  }
  if (dirname(dir) === resolve(roots.disabledRoot)) {
    return { ok: true, action: "enable", from: dir, to: join(resolve(roots.enabledRoot), name) };
  }
  return {
    ok: false,
    error: `not a user-scoped Claude skill: ${dir} — only direct children of ${roots.enabledRoot} and ${roots.disabledRoot} can be toggled`,
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
