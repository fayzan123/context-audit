import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSkillMd } from "../skills.js";

/**
 * Open an inventory item's file for the user. `code --goto` when the VS Code
 * CLI exists, else the OS opener. $EDITOR is deliberately not honored — a
 * terminal editor cannot be usefully spawned from a detached server process.
 *
 * The path always comes from the server-side inventory (resolved from an item
 * ID), but "the server chose it" is not the same as "it is safe to hand to a
 * launcher": the inventory contains directory names an attacker picked, since
 * a repo can ship any `.claude/skills/<name>/`. Two rules follow, and both are
 * load-bearing:
 *
 *  - Only a regular FILE is ever opened. `open <dir>` on macOS is the
 *    launch-this-application verb, so a planted `.claude/skills/Update.app`
 *    with no SKILL.md would execute on click.
 *  - No launcher that re-parses its arguments as a shell. `cmd /c start` does:
 *    libuv leaves a space-free argument unquoted, and cmd.exe treats `&` — a
 *    legal Windows filename character — as a command separator (the
 *    BatBadBut / CVE-2024-24576 class). rundll32 does no such re-parsing.
 */

let codeAvailable: boolean | undefined;

function hasCodeCli(): boolean {
  if (codeAvailable === undefined) {
    try {
      codeAvailable = spawnSync("code", ["--version"], { stdio: "ignore", timeout: 3000 }).status === 0;
    } catch {
      codeAvailable = false;
    }
  }
  return codeAvailable;
}

/**
 * For a directory item, the file worth opening is its entry file — resolved
 * exactly the way discovery resolves it. Probing the two literal spellings
 * missed `Skill.md`, which the engine happily audits (the harness matches
 * case-insensitively), so on Linux the open action refused a skill the
 * dashboard had just priced and flagged.
 *
 * `statSync` here is deliberate: skill directories are legitimately symlinks,
 * and following a link to a DIRECTORY is safe. What must not be followed is
 * the final name handed to the launcher — see the lstat check below.
 */
export function openTarget(path: string): string {
  try {
    if (statSync(path).isDirectory()) {
      // Plain files only, the same filter discovery applies: a directory or
      // symlink named `SKILL.MD` sitting beside a real `skill.md` must not
      // shadow it and turn a valid item into a refusal.
      const entry = readdirSync(path).find((name) => {
        if (!isSkillMd(name)) return false;
        try {
          return lstatSync(join(path, name)).isFile();
        } catch {
          return false;
        }
      });
      if (entry) return join(path, entry);
    }
  } catch {
    // Fall through: the regular-file check below reports the missing path.
  }
  return path;
}

export type OpenResult = { ok: true; command: string; target: string } | { ok: false; error: string };

export function openInEditor(path: string): OpenResult {
  const target = openTarget(path);
  let entry;
  try {
    // lstat, not stat: a `SKILL.md` that is a SYMLINK to an executable is a
    // regular file as far as stat is concerned, so following the link handed
    // the launcher exactly the thing this check exists to refuse. The name
    // itself must be a plain, non-executable file.
    entry = lstatSync(target);
  } catch {
    return { ok: false, error: `nothing to open at ${target} — rescan and retry` };
  }
  if (!entry.isFile()) {
    // A directory with no entry file has no document to show, and a symlink
    // — which lstat reports as not-a-file — is not one either. `open` on
    // either is the launch-this-thing verb.
    return {
      ok: false,
      error: `no readable entry file in ${target} — nothing here is a plain document to open`,
    };
  }
  const useCode = hasCodeCli();
  // The exec bit only matters for a launcher that could ACT on it. `code
  // --goto` opens a buffer and never runs its argument, so refusing there
  // would break the common case for no gain — including WSL DrvFs and other
  // mounts that mark every file 0o777, and repos that commit SKILL.md as 100755.
  // Windows is exempt for the same mass-0o777 reason.
  if (!useCode && process.platform !== "win32" && (entry.mode & 0o111) !== 0) {
    return {
      ok: false,
      error: `${target} is marked executable — refusing to hand it to the OS opener; open it from your editor instead`,
    };
  }

  let command: string;
  let args: string[];
  if (useCode) {
    command = "code";
    args = ["--goto", target];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [target];
  } else if (process.platform === "win32") {
    // Never `cmd /c start`: cmd.exe re-parses the argument as a command line.
    command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
    args = ["url.dll,FileProtocolHandler", target];
  } else {
    command = "xdg-open";
    args = [target];
  }
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // The HTTP response has already been sent by the time a missing opener
    // surfaces; log rather than crash the server. The path is stripped of
    // control characters — it came from a directory name someone else chose.
    console.error(
      `context-audit ui: could not launch ${command} for ${target.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")}`
    );
  });
  child.unref();
  return { ok: true, command, target };
}

/** Test seam: force re-detection of the VS Code CLI (PATH changes in tests). */
export function resetOpenCache(): void {
  codeAvailable = undefined;
}

/** Open a URL in the default browser — the OS opener, never the editor. */
export function openUrl(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.error(`context-audit ui: could not open a browser — visit the URL above yourself`);
  });
  child.unref();
}
