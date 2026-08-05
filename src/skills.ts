import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { AssetKind, Injection, Skill, SkillFile } from "./types.js";
import { flatten, parseYaml } from "./yaml.js";

/**
 * Scan cap. Set high deliberately: the previous 512KB cap meant a script padded
 * with a comment block simply went unread, which is a one-line evasion. Files
 * past the cap are scanned up to it and reported as truncated, never silently.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Directories never walked. Deliberately empty: every entry here was a free
 * hiding place. `__pycache__` used to be skipped, so `__pycache__/helper.py`
 * with a live payload was never read and never reported — the same bug that had
 * already been fixed for `node_modules` and `.git`, one directory name later.
 */
const SKIP_DIRS = new Set<string>();

/**
 * A vendored tree is walked, not skipped — skipping it made `node_modules/x/i.js`
 * a free hiding place. The budget bounds the cost for a skill that really does
 * vendor its dependencies; hitting it is reported rather than silently truncating.
 */
const VENDOR_DIRS = new Set(["node_modules", "vendor", "site-packages"]);
export const VENDOR_FILE_BUDGET = 3000;

/**
 * Git's own object storage, matched by SHAPE rather than by directory name.
 *
 * Skipping the whole `objects/`, `refs/`, `logs/` … subtrees reopened the exact
 * blind spot the rest of this file exists to close: `.git/objects/payload.sh`
 * was never walked, so it was never scanned and never reported. Loose objects
 * and packfiles have rigid names, so this shape bounds what has to be *read in
 * full* while leaving anything an attacker actually plants fully visible.
 *
 * The shape is NOT a skip. Refusing to look at a file because its name matches
 * this pattern made the name itself the hiding place: a plaintext payload
 * called `.git/objects/ab/<38 hex>` was never read, never scanned, never
 * counted, and produced zero findings — while the README promised the walker
 * enters `objects/`. Now the shape only decides how cheaply the file is ruled
 * out: real git data is zlib and fails the text heuristic on a 4KB prefix,
 * a planted script reads as text and is scanned like any other file.
 */
const GIT_OBJECT_DATA =
  /(?:^|\/)\.git\/objects\/(?:[0-9a-f]{2}\/[0-9a-f]{30,}|pack\/[^/]+\.(?:pack|idx|rev|mtimes)|info\/[^/]*)$/;

/** Extensions whose contents are code or prose regardless of what the byte heuristic thinks. */
const TEXT_EXT =
  /\.(?:md|mdc|markdown|txt|sh|bash|zsh|fish|ps1|bat|cmd|js|mjs|cjs|ts|tsx|jsx|py|rb|pl|php|lua|r|json|jsonc|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|sql|applescript|command)$/i;

/** A file with no extension in a bin/ or scripts/ dir is an executable script by convention. */
const SCRIPT_PATH = /(?:^|\/)(?:bin|scripts?|hooks)\/[^/.]+$/;

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Read the first `n` bytes without pulling a multi-gigabyte file into memory. */
function readPrefix(path: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Byte heuristic for files with no telling extension. Deliberately not the only
 * gate: a script prefixed with control bytes still executes, so an extension or
 * a shebang overrides this and forces a scan.
 */
function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  let suspect = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspect++;
  }
  return sample.length === 0 || suspect / sample.length < 0.05;
}

function shouldScan(relPath: string, buf: Buffer): boolean {
  // A declared text extension or a shebang overrides the byte heuristic: a shell
  // script prefixed with control bytes still executes, and skipping it on those
  // bytes alone was a one-line way to make a whole payload invisible.
  if (TEXT_EXT.test(relPath)) return true;
  if (buf.subarray(0, 2).toString("latin1") === "#!") return true;
  // An extensionless file in bin/ is a script by convention — but compiled
  // binaries live there too, so it still has to look like text.
  if (SCRIPT_PATH.test(relPath)) return isProbablyText(buf);
  return isProbablyText(buf);
}

/** A published package brings its own manifest; a hiding place does not. */
function isPackageRoot(dir: string): boolean {
  return ["package.json", "__init__.py", "METADATA", "RECORD"].some((f) => existsSync(join(dir, f)));
}

function collectFiles(
  root: string,
  dir: string,
  out: SkillFile[],
  seen = new Set<string>(),
  inGit = false,
  inVendorPkg = false,
  /**
   * Optional containment root (a REAL path). When set, an entry whose real
   * path resolves outside it is recorded and NOT followed.
   *
   * Only third-party plugin trees pass this. User skills must keep following
   * symlinks wherever they point — a skills directory is commonly a symlink
   * farm into the user's own repos (24 of 37 on the machine this was built
   * on), and content the agent can read through such a link is content that
   * has to be scanned.
   *
   * The escape is REPORTED, never silently skipped: refusing to look at
   * something without saying so is how a boundary becomes a hiding place,
   * which is the failure this file's other comments keep documenting. A
   * plugin that symlinks out of its own install is itself the finding.
   */
  boundary?: string
): void {
  try {
    const real = realpathSync(dir);
    if (seen.has(real)) return; // symlink cycle
    seen.add(real);
  } catch {
    return;
  }
  // An unreadable directory is one directory's worth of missing coverage, not
  // a reason to abandon the audit. Unguarded, a single EACCES anywhere under a
  // plugin tree threw all the way out of discovery and killed the whole
  // multi-source run — codex, cursor and the user's own skills included —
  // with exit 2 and no report at all.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    if (boundary !== undefined) {
      let real: string | undefined;
      try {
        real = realpathSync(absPath);
      } catch {
        real = undefined; // broken link: nothing to follow, nothing to escape
      }
      if (real !== undefined && real !== boundary && !real.startsWith(boundary + sep)) {
        out.push({
          relPath: relative(root, absPath),
          absPath,
          bytes: 0,
          escapedTo: real,
        });
        continue;
      }
    }
    // statSync follows symlinks — skills directories commonly symlink into repos.
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue; // broken symlink
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Descending into a published package: mark everything below it so its
      // contents are counted but not read. Scanning 6,000 files of somebody
      // else's library cost seconds and produced only its sourcemaps and emoji
      // test fixtures — never a finding about the skill.
      // The parent is the vendor dir itself, or a `@scope` directory inside one.
      const parent = basename(dir);
      const inVendorDir =
        VENDOR_DIRS.has(parent) || (parent.startsWith("@") && VENDOR_DIRS.has(basename(dirname(dir))));
      const entersPackage = !inVendorPkg && inVendorDir && isPackageRoot(absPath);
      if (VENDOR_DIRS.has(entry.name)) {
        const before = out.length;
        collectFiles(root, absPath, out, seen, inGit, inVendorPkg, boundary);
        if (out.length - before >= VENDOR_FILE_BUDGET) {
          // The collected files are KEPT. Discarding them made "pad the vendor
          // tree past the budget" a complete bypass: the walk had already paid
          // for reading them, and throwing them away meant a payload sitting in
          // node_modules/evil/run.sh was never pattern-matched at all. The tree
          // is still reported as oversized so the cost is visible.
          out.push({ relPath: relative(root, absPath), absPath, bytes: 0, skippedDir: true });
        }
        continue;
      }
      collectFiles(root, absPath, out, seen, inGit || entry.name === ".git", inVendorPkg || entersPackage, boundary);
      continue;
    }
    if (!stat.isFile()) continue;
    const bytes = stat.size;
    const relPath = relative(root, absPath);
    const file: SkillFile = { relPath, absPath, bytes };
    // Git's own compressed storage carries no readable payload — but proving
    // that from the name alone is what made the name a hiding place. Pay for a
    // 4KB prefix instead: compressed object data fails the text heuristic and
    // is recorded as git data, while a plaintext payload wearing a hash for a
    // name reads as text and falls through to the normal full scan below.
    if (inGit && GIT_OBJECT_DATA.test("/" + relPath)) {
      if (!isProbablyText(readPrefix(absPath, 4096))) {
        file.gitObject = true;
        out.push(file);
        continue;
      }
    }
    if (inVendorPkg) {
      file.vendorPackage = true;
      out.push(file);
      continue;
    }
    const buf = bytes <= MAX_FILE_BYTES ? readFileSync(absPath) : readPrefix(absPath, MAX_FILE_BYTES);
    if (shouldScan(relPath, buf)) {
      file.content = stripBom(buf.toString("utf8"));
      if (bytes > MAX_FILE_BYTES) file.truncated = true;
    }
    out.push(file);
  }
}

/**
 * Frontmatter for the content facts (name, description). Uses the same parser
 * as the security checks — a second, laxer reading of the same bytes is how the
 * two halves of a scanner end up disagreeing about what a skill declares.
 */
export function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const text = stripBom(md);
  if (!text.startsWith("---")) return { fm: {}, body: md };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: md };
  const block = text.slice(text.indexOf("\n") + 1, end);
  const fm: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseYaml(block).root)) fm[k] = flatten(v) ?? "";
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  return { fm, body };
}

/**
 * The harness resolves the entry file on a case-insensitive filesystem, so a
 * `skill.md` loads for real while an exact-match scanner sees no skill at all
 * and silently skips every frontmatter check.
 */
export function isSkillMd(relPath: string): boolean {
  return relPath.toLowerCase() === "skill.md";
}

/**
 * The absolute file a finding is about, resolved from the asset that produced
 * it. Every finding must carry this, and it has to be computed with the asset
 * in hand: findings identify their asset by DISPATCH NAME, and a name is not
 * unique on a real machine — an agent and a skill can share one, as can a user
 * and a project copy. Resolving afterwards through a name-keyed map hands the
 * finding whichever same-named asset was registered last: the wrong file to
 * open, which is precisely the failure "verify before you alarm the user"
 * depends on not having.
 *
 * A single-file asset (an agent or command `.md`) IS its own `dir`, so the
 * fallback must not re-join its basename onto it — that produced `…/x.md/x.md`.
 * Synthetic labels (`node_modules`, `.git/objects`) match no real file and
 * resolve to the asset itself.
 */
export function findingPath(skill: Skill, file: string): string {
  const hit = skill.files.find((f) => f.relPath === file);
  if (hit) return hit.absPath;
  const singleFile = skill.files.length === 1 && skill.files[0].absPath === skill.dir;
  return singleFile ? skill.dir : join(skill.dir, file);
}

/** Load a single skill from a directory containing SKILL.md (or a bare .md file). */
export function loadSkill(path: string, boundary?: string): Skill {
  const stat = statSync(path);
  if (stat.isFile()) {
    const content = stripBom(readFileSync(path, "utf8"));
    const { fm, body } = parseFrontmatter(content);
    return {
      dirName: fm["name"] ?? path.split("/").pop()!.replace(/\.md$/, ""),
      dir: path,
      fmName: fm["name"],
      description: fm["description"],
      body,
      files: [{ relPath: path.split("/").pop()!, absPath: path, content, bytes: stat.size }],
      hasSkillMd: true,
    };
  }
  const files: SkillFile[] = [];
  collectFiles(path, path, files, new Set<string>(), false, false, boundary);
  const skillMd = files.find((f) => isSkillMd(f.relPath));
  const dirName = path.replace(/\/+$/, "").split("/").pop()!;
  if (!skillMd?.content) {
    return { dirName, dir: path, body: "", files, hasSkillMd: false };
  }
  const { fm, body } = parseFrontmatter(skillMd.content);
  return {
    dirName,
    dir: path,
    fmName: fm["name"],
    description: fm["description"],
    body,
    files,
    hasSkillMd: true,
  };
}

/** Discover all skills in a skills directory (each subdirectory with a SKILL.md). */
export function discoverSkills(dir: string, boundary?: string): Skill[] {
  if (!existsSync(dir)) throw new Error(`skills directory not found: ${dir}`);
  const skills: Skill[] = [];
  // Same reasoning as collectFiles: a directory this process cannot read is a
  // gap in coverage, never a fatal error for every other source in the run.
  let rootEntries;
  try {
    rootEntries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of rootEntries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = statSync(path); // follows symlinks
    } catch {
      continue;
    }
    if (stat.isDirectory() || (stat.isFile() && entry.name.endsWith(".md"))) {
      skills.push(loadSkill(path, boundary));
    }
  }
  return skills.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/** Every .md file under a directory, symlink-tolerant, silent on unreadable entries. */
export function mdFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (d: string): void => {
    // statSync below follows symlinks, so a directory linking to an ancestor
    // would recurse forever without this.
    try {
      const real = realpathSync(d);
      if (seen.has(real)) return;
      seen.add(real);
    } catch {
      return;
    }
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      let stat;
      try {
        stat = statSync(p); // follows symlinks, same policy as the skills walker
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile() && entry.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Load a single .md file as an asset with an explicit dispatch name and kind. */
export function fileAsset(
  path: string,
  name: string,
  source: Skill["source"],
  kind: AssetKind,
  injection: Injection
): Skill {
  return { ...loadSkill(path), dirName: name, source, kind, injection };
}
