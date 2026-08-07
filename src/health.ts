import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { BUILTIN_COMMANDS, type UiItem } from "./types.js";

// Content-health facts: do an asset's references resolve, when was it last
// edited, is it the same body as its twin under another provider, did somebody
// type a name that does not exist, and does anything else name it. Every
// function is deterministic over injected paths and injected text — nothing
// here reads $HOME or the environment, the same rule provenance.ts follows, so
// a fixture home produces a fixture answer. Unknowable inputs return
// `undefined` (the caller renders "n/a"); they never return a zero, because a
// silent "0 missing" is the one answer a reader would act on wrongly.

export type Refs = NonNullable<UiItem["refs"]>;

/** Latest edit across an asset's files, and which evidence produced the date. */
export interface Freshness {
  editedAt: string;
  source: "git" | "mtime";
}

/**
 * 2000-01-01T00:00:00Z, the same floor provenance.ts applies: a filesystem
 * that does not record a stamp reports epoch 0, and "last edited 1970" would
 * render as a 20,000-day-old skill rather than as the missing datum it is.
 */
const MIN_VALID_MS = 946684800000;

/**
 * Bounded work per row — this runs once per inventory row on machines with
 * ~200 assets. A body that mentions a thousand paths gets its first 200
 * checked rather than a thousand stat calls; a multi-megabyte instruction file
 * gets its first 512KB scanned for references to other assets.
 */
const MAX_REF_CANDIDATES = 200;
const MAX_BODY_SCAN = 512 * 1024;

const iso = (ms: number): string => new Date(ms).toISOString();
const validMs = (ms: number): boolean => Number.isFinite(ms) && ms > MIN_VALID_MS;

// --- references ------------------------------------------------------------

/** `[text](path)` and `![alt](<path>)`, title strings and angle brackets stripped. */
const MD_LINK = /\[[^\]\n]{0,200}\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)\n]*["'])?\s*\)/g;

/** Inline code spans — where a SKILL.md most often names a bundled file. */
const INLINE_CODE = /`([^`\n]{1,200})`/g;

/**
 * A bare relative path in prose: at least one directory component and a real
 * file extension. The lookbehind refuses anything already inside a longer path
 * or a URL — without it `https://host/docs/a.md` contributes `host/docs/a.md`
 * as a "missing file", which is the loudest possible false positive.
 */
const BARE_PATH = /(?<![\w`/~.-])((?:\.{1,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?=[\s)\]'",;:!?]|$)/g;

/** A trailing `.ext` that is a real extension rather than the end of a sentence. */
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** Anything with a scheme, a protocol-relative prefix, or a mail target is not a file. */
const URL_LIKE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/;

/** Placeholders and globs name a shape, not a file that can be missing. */
const NOT_LITERAL = /[<>{}$*?|\\\s]/;
/**
 * Template stand-ins that are literal enough to survive NOT_LITERAL but were
 * never meant to name a real file: an ellipsis continuation (`…/task-N.md`),
 * the documentation convention `path/to/thing`, and an `@`-prefixed reference
 * (`@skills/testing/SKILL.md`), which addresses a dispatch namespace rather
 * than a location on disk. All three were observed being reported as missing
 * files on the reference machine.
 */
const PLACEHOLDER = /(^|\/)(\.\.\.|…)|(^|\/)(path|exact)\/to\//i;

interface RefCandidate {
  /** The reference exactly as the entry file writes it — what the reader will search for. */
  raw: string;
  /** Absolute resolved target, guaranteed to sit inside the asset root. */
  abs: string;
  line: number;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The first two bytes, without pulling a file of unknown size into memory. */
function startsWithShebang(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(2);
    const read = readSync(fd, buf, 0, 2, 0);
    return read === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** The asset's containment root: the skill directory, or the directory holding a single-file asset. */
/**
 * The directory a reference is resolved against — and only for assets that
 * can actually HAVE one.
 *
 * A single-file asset (an agent or command `.md`) ships no bundled files, so
 * every path in its body is prose: an import in an example snippet, a file it
 * tells you to create in your own project, a path in a template. Resolving
 * those against the file's PARENT is what turned `~/.claude/agents/` into the
 * root for 30 unrelated agents on the reference machine and reported 97 paths
 * as missing, none of which were. A directory-shaped asset is the only kind
 * that can bundle a file and therefore the only kind that can fail to.
 */
function assetRoot(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? resolve(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is `abs` still inside the asset once every symlink on the way to it has been
 * resolved? `resolve()` only cancels `..` textually, so the lexical test below
 * passes for `link/secret/tool.sh` while `statSync` and the shebang read follow
 * the link straight out of the asset — a plugin that ships one link made this
 * function stat and READ files elsewhere on the machine and report them in
 * `missing`/`notExecutable` as things the plugin itself ships. This is the
 * boundary `discoverPluginAssets` already resolves with `realpathSync` before
 * walking a third-party tree (plugins.ts), applied to the one other place that
 * opens files by a path an untrusted body chose.
 *
 * A reference that does not exist yet still has to be classifiable, so the
 * deepest EXISTING prefix is resolved and the unresolvable tail appended: a
 * missing file under a link that escapes is an escape, not a missing bundled
 * file. The escape is dropped rather than reported — `discoverPluginAssets`
 * already records it as a `symlink-escape` finding on the asset, and repeating
 * it here as "1 referenced path missing" would name it as the opposite of what
 * it is.
 */
function realContained(abs: string, realRoot: string): boolean {
  let prefix = abs;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(prefix);
    } catch {
      const up = dirname(prefix);
      if (up === prefix) return false;
      prefix = up;
      continue;
    }
    // `prefix` is always a leading segment run of `abs`, so the remainder is
    // the part no link could have redirected — it has no existing component.
    const full = real + abs.slice(prefix.length);
    return full === realRoot || full.startsWith(realRoot + sep);
  }
}

/**
 * Turn one extracted token into a checkable reference, or reject it. The
 * rejections are the whole point: a URL, an anchor, an absolute path, a glob
 * and a path that climbs out of the skill directory are all things this tool
 * has no standing to call "missing", and reporting them as missing files is
 * how a facts-only readout becomes noise a user learns to skip.
 */
function toCandidate(rawIn: string, root: string, realRoot: string): { raw: string; abs: string } | undefined {
  // Fragments and query strings address a location inside a target, not a
  // different file; a bare `#anchor` addresses this very document.
  const raw = rawIn.replace(/[#?].*$/, "").trim();
  if (!raw || raw === "." || raw === "..") return undefined;
  if (URL_LIKE.test(raw) || NOT_LITERAL.test(raw) || PLACEHOLDER.test(raw)) return undefined;
  if (raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("@")) return undefined;
  if (!HAS_EXTENSION.test(raw)) return undefined;
  const abs = resolve(root, raw);
  // Escaping the root means the reference is to the user's project, another
  // skill, or the machine at large — outside what this asset ships and outside
  // what its author can fix. Tested twice: lexically first (cheap, and it
  // rejects the `../` majority without a syscall), then through the links.
  if (abs !== root && !abs.startsWith(root + sep)) return undefined;
  if (!realContained(abs, realRoot)) return undefined;
  return { raw, abs };
}

/**
 * Does the entry file's own bundle hold together? Static path extraction from
 * the entry text plus `existsSync`, with an exec-bit check on the scripts it
 * points at. Line numbers are the ENTRY FILE's, so the drawer can say "line
 * 42" and the reader can go look.
 *
 * `checked` is the denominator and is never omitted: "0 missing" is a clean
 * bill of health only next to how many paths were examined, and an entry file
 * that names no paths at all has to read as "nothing to check", not as "fine".
 *
 * Returns undefined when there is no entry text to read — an unparsed asset
 * gets no refs section rather than an invented empty one.
 */
export function resolveRefs(asset: { path: string; entry?: string }): Refs | undefined {
  if (asset.entry === undefined) return undefined;
  const root = assetRoot(asset.path);
  if (root === undefined) return undefined;
  // The containment boundary is the REAL root: an asset reached through a
  // symlink (a skills directory is commonly a link farm into the user's own
  // repos) must not have its own bundled files read as escapes.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return undefined;
  }
  const text = asset.entry.length > MAX_BODY_SCAN ? asset.entry.slice(0, MAX_BODY_SCAN) : asset.entry;
  const starts = lineStarts(text);

  // Deduped by resolved target: `./x.md` and `x.md` on two lines are one
  // reference to one file, and reporting it twice would inflate both the
  // numerator and the denominator.
  const byAbs = new Map<string, RefCandidate>();
  const add = (rawIn: string, index: number): void => {
    if (byAbs.size >= MAX_REF_CANDIDATES) return;
    const hit = toCandidate(rawIn, root, realRoot);
    if (!hit) return;
    // A single-segment name (`package.json`, `config.yaml`) in prose usually
    // means the USER's file, not one this skill ships — so it can be confirmed
    // present but is never reported missing. Guessing wrong here would print
    // "1 referenced path missing: package.json" about a file that was never
    // supposed to be in the skill directory.
    if (!hit.raw.includes("/") && !existsSync(hit.abs)) return;
    if (byAbs.has(hit.abs)) return;
    byAbs.set(hit.abs, { raw: hit.raw, abs: hit.abs, line: lineAt(starts, index) });
  };

  for (const m of text.matchAll(MD_LINK)) add(m[1], m.index ?? 0);
  for (const m of text.matchAll(INLINE_CODE)) add(m[1], m.index ?? 0);
  for (const m of text.matchAll(BARE_PATH)) add(m[1], m.index ?? 0);

  const missing: Refs["missing"] = [];
  const notExecutable: Refs["notExecutable"] = [];
  // Mode bits carry no meaning on Windows — every referenced script would read
  // as "not executable" there, so the check is skipped rather than faked.
  const execChecked = process.platform !== "win32";
  for (const c of [...byAbs.values()].sort((a, b) => a.line - b.line || (a.raw < b.raw ? -1 : 1))) {
    let mode: number | undefined;
    let isFile = false;
    try {
      const st = statSync(c.abs);
      mode = st.mode;
      isFile = st.isFile();
    } catch {
      // A broken symlink lands here too, and a reference that resolves to
      // nothing readable is exactly what this row is for.
      missing.push({ path: c.raw, line: c.line });
      continue;
    }
    // A shebang is the file's own claim that it is executed directly; a helper
    // run as `python scripts/x.py` needs no exec bit and is not flagged for
    // lacking one.
    if (execChecked && isFile && mode !== undefined && (mode & 0o111) === 0 && startsWithShebang(c.abs)) {
      notExecutable.push({ path: c.raw, line: c.line });
    }
  }

  return { checked: byAbs.size, missing, notExecutable };
}

// --- freshness -------------------------------------------------------------

/**
 * Per-build git memo. Held by the caller rather than in module state because a
 * rescan must see new commits: a process-lifetime cache would answer the
 * second scan with the first scan's repository.
 */
export interface HealthCache {
  /** Directory → enclosing repo root, or "" for "walked to the filesystem root, no repo". */
  repoRoot: Map<string, string>;
  /** Repo root → shallow. A shallow clone's oldest commit is its clone horizon, not history. */
  shallow: Map<string, boolean>;
  /** Repo root → absolute paths with uncommitted changes; undefined when git could not say. */
  dirty: Map<string, Set<string> | undefined>;
  /**
   * Directory scanned → last-commit date (ms) for every path under it, files
   * and directories alike; undefined when git could not answer. One entry per
   * PARENT directory, which is what collapses the log spawns — see logDates.
   */
  logDates: Map<string, Map<string, number> | undefined>;
}

export function createHealthCache(): HealthCache {
  return { repoRoot: new Map(), shallow: new Map(), dirty: new Map(), logDates: new Map() };
}

/**
 * provenance.ts keeps its own copy of this; both are deliberately narrow —
 * stderr discarded so a repo-less directory prints nothing, and a timeout so a
 * wedged filter or a network-backed filesystem cannot hang an audit.
 *
 * `maxBuffer` is raised off Node's 1MB default because two of the callers
 * below now read a whole listing rather than one line: `git log --name-only`
 * over a directory of assets, and `status --porcelain` in a large working
 * tree. Overflowing it does not truncate — execFileSync throws, which this
 * catch would turn into "git could not say" for every asset at once.
 */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * Find the enclosing repo by walking up for a `.git` entry — no subprocess.
 * `rev-parse --show-toplevel` would cost one spawn per asset just to learn
 * that ~/.claude/skills is not a repository, which on 200 assets is the
 * difference between a scan and a wait.
 */
function repoRootOf(dir: string, cache: HealthCache): string | undefined {
  const chain: string[] = [];
  let cur = resolve(dir);
  let found = "";
  for (;;) {
    const seen = cache.repoRoot.get(cur);
    if (seen !== undefined) {
      found = seen;
      break;
    }
    chain.push(cur);
    // A `.git` FILE is a worktree or submodule pointer — still a repository.
    if (existsSync(join(cur, ".git"))) {
      found = cur;
      break;
    }
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const d of chain) cache.repoRoot.set(d, found);
  return found || undefined;
}

function isShallow(root: string, cache: HealthCache): boolean {
  const memo = cache.shallow.get(root);
  if (memo !== undefined) return memo;
  // Anything but a clear "false" is treated as shallow: an unreadable or
  // unversioned answer must not be allowed to date an asset at a clone horizon.
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"])?.trim() !== "false";
  cache.shallow.set(root, shallow);
  return shallow;
}

/**
 * Paths with uncommitted changes, one `git status` per REPO rather than per
 * asset. Needed because the two available dates disagree in opposite ways: a
 * fresh clone rewrites every mtime to the clone (mtime lies about editing),
 * and an uncommitted edit leaves the last commit date behind (git lies about
 * editing). Knowing which paths are dirty is what lets each be trusted where
 * it is true — and "did my edit fix it?" is asked most often about an edit
 * that has not been committed yet.
 */
function dirtyPaths(root: string, cache: HealthCache): Set<string> | undefined {
  if (cache.dirty.has(root)) return cache.dirty.get(root);
  const out = git(root, ["status", "--porcelain", "--no-renames"]);
  let set: Set<string> | undefined;
  if (out !== undefined) {
    set = new Set<string>();
    for (const line of out.split("\n")) {
      if (line.length < 4) continue;
      // Porcelain v1: two status columns, a space, then the path. Quoted paths
      // (non-ASCII bytes) keep their quotes — a prefix match still holds for
      // the directory case, and a mis-parsed exotic filename only costs a
      // fallback to the git date.
      set.add(resolve(root, line.slice(3).trim()));
    }
  }
  cache.dirty.set(root, set);
  return set;
}

/**
 * Commits read per directory — the bound on the listing logDates holds in
 * memory. It bites only where thousands of commits touched this one directory,
 * and a directory that busy dates every asset in it long before the cap;
 * anything older falls back to mtime, labelled mtime.
 */
const MAX_LOG_COMMITS = 5000;

/**
 * Last-commit dates for a whole directory of assets in ONE subprocess.
 *
 * The per-asset `git log -1 --format=%aI -- <asset>` this replaces spawned once
 * per row: 150 skills in a git-backed home measured 754 ms of the 780 ms
 * rescan, every time the button is pressed, because each spawn re-walks the
 * same history to answer about one sibling. Assets live in directories
 * (~/.claude/skills/*, ~/.claude/agents/*.md), so one log scoped to the PARENT
 * answers for all of them at the cost of the single walk they were each paying
 * for.
 *
 * Semantics are preserved exactly: git lists commits newest-first, so the
 * FIRST date seen for a path is the one `-1` would have printed, and recording
 * that date against every ancestor directory as well reproduces the directory
 * pathspec (`-- .`) answer — the newest commit touching anything inside.
 * Later (older) commits never overwrite, which is also why the ancestor walk
 * can stop at the first directory already recorded.
 *
 * `scope` must sit inside `root`; paths git prints are root-relative. A path
 * git quotes (a newline or a quote in the filename) is skipped rather than
 * mis-decoded: that asset falls back to mtime and says so, which is the same
 * answer an untracked file already gets.
 */
function logDates(root: string, scope: string, cache: HealthCache): Map<string, number> | undefined {
  const memo = cache.logDates.get(scope);
  if (memo !== undefined || cache.logDates.has(scope)) return memo;
  const out = git(scope, ["log", `--max-count=${MAX_LOG_COMMITS}`, "--format=%x00%aI", "--name-only", "--", "."]);
  let dates: Map<string, number> | undefined;
  if (out !== undefined) {
    dates = new Map<string, number>();
    // Each commit is one NUL-introduced chunk: the date, then its file list.
    for (const chunk of out.split("\0")) {
      const nl = chunk.indexOf("\n");
      if (nl === -1) continue; // a commit whose diff lists nothing (a merge)
      const ms = Date.parse(chunk.slice(0, nl));
      if (!validMs(ms)) continue;
      for (const rel of chunk.slice(nl + 1).split("\n")) {
        if (!rel || rel.startsWith('"')) continue;
        const abs = resolve(root, rel);
        if (abs !== scope && !abs.startsWith(scope + sep)) continue;
        for (let p = abs; !dates.has(p); p = dirname(p)) {
          dates.set(p, ms);
          if (p === scope) break;
        }
      }
    }
  }
  cache.logDates.set(scope, dates);
  return dates;
}

function maxMtime(paths: Iterable<string>): number | undefined {
  let newest: number | undefined;
  for (const p of paths) {
    let ms: number;
    try {
      ms = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (validMs(ms) && (newest === undefined || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * When was this asset last edited? Answers both directions of the same
 * question — "edited 5d ago, 2 fires since" and "unchanged 187d, 41 fires in
 * that span" — so it must not be off by a checkout: git's last-commit date is
 * preferred wherever the asset is tracked in a non-shallow repo, and an mtime
 * only wins when it is newer AND git confirms the path is dirty (a real
 * uncommitted edit rather than a clone that touched every file at once).
 *
 * `files` is the asset's own file list (absolute paths); the root is always
 * included, because adding or deleting a bundled file moves the directory's
 * mtime and nothing else's. Returns undefined when neither source has a valid
 * stamp — never a 1970 date, never today by default.
 *
 * Pass one `cache` across the whole inventory: it collapses the repo lookup,
 * the shallow/dirty probes and the last-commit log to one subprocess per
 * repository plus one per directory of assets.
 */
export function freshnessOf(asset: { path: string; files?: string[] }, cache?: HealthCache): Freshness | undefined {
  const memo = cache ?? createHealthCache();
  // Everything below works in PHYSICAL paths. A skills directory is commonly a
  // symlink farm into the user's own repos (24 of 37 on the machine this was
  // built on), and git resolves its own cwd, so a lexical path would ask one
  // repository for a date and another for the dirty set — and would look up a
  // log answer under a path that repository never prints.
  let abs = resolve(asset.path);
  try {
    abs = realpathSync(abs);
  } catch {
    /* a path that will not resolve has no git answer; mtime still might */
  }
  const mtimeMs = maxMtime([abs, ...(asset.files ?? [])]);

  let isDir: boolean;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    return mtimeMs === undefined ? undefined : { editedAt: iso(mtimeMs), source: "mtime" };
  }

  const cwd = isDir ? abs : dirname(abs);
  const root = repoRootOf(cwd, memo);
  // One log per PARENT directory, shared by every asset in it (see logDates);
  // the asset's own entry covers all of its bundled files at once. That is also
  // why the case-insensitive SKILL.md lookup provenance.ts needs is not needed
  // here: nothing names the entry file, so nothing can miss it because the
  // harness accepted `skill.md`. An asset that IS the repository root has no
  // parent inside the repo, so the repo itself is the scope.
  let gitMs: number | undefined;
  if (root && !isShallow(root, memo)) {
    const parent = dirname(abs);
    const scope = parent === root || parent.startsWith(root + sep) ? parent : root;
    gitMs = logDates(root, scope, memo)?.get(abs);
  }

  if (gitMs === undefined) {
    return mtimeMs === undefined ? undefined : { editedAt: iso(mtimeMs), source: "mtime" };
  }
  if (mtimeMs !== undefined && mtimeMs > gitMs && root) {
    const dirty = dirtyPaths(root, memo);
    const touched =
      dirty !== undefined && [...dirty].some((p) => p === abs || p.startsWith(abs + sep) || abs.startsWith(p + sep));
    if (touched) return { editedAt: iso(mtimeMs), source: "mtime" };
  }
  return { editedAt: iso(gitMs), source: "git" };
}

// --- cross-provider identity ----------------------------------------------

/**
 * Stable identity for an asset's BODY — the evidence behind "also exists as a
 * Codex skill (identical body)".
 *
 * What is hashed: the body only, frontmatter excluded, because the same
 * instructions ported between harnesses legitimately carry different
 * frontmatter (Claude wants `name`/`description`, Codex and Cursor want other
 * keys) and hashing that would report every genuine twin as different. Callers
 * pass `Skill.body`, which the frontmatter parser has already stripped.
 *
 * What is normalized away: a BOM, CRLF/CR line endings, trailing whitespace on
 * each line, leading and trailing blank lines, and Unicode composition (NFC).
 * Every one of those is a difference a file gets by being re-saved by a
 * different editor on a different OS, never by being rewritten.
 *
 * What is deliberately NOT normalized: case, internal spacing, indentation,
 * punctuation and ordering. `identical` renders as a factual claim, so two
 * bodies that merely say similar things must never collide — and a body whose
 * one instruction differs by a single word has to hash differently.
 */
export function bodyHash(body: string): string {
  const text = (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .normalize("NFC");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// --- near misses -----------------------------------------------------------

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max`. Bounded because
 * the answer past the threshold is never used and the strings compared here
 * are dispatch names, not documents.
 */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Optimal string alignment, not plain Levenshtein: an ADJACENT TRANSPOSITION
  // costs 1 here, where Levenshtein charges 2. That difference decides real
  // cases — `stapel` for `staple` is the classic fat-finger, but at six
  // characters the budget below is one edit, so Levenshtein scored it 2 and
  // the typo went unattributed. Transposition is admitted on its own merits
  // and the substitution budget is untouched, so nothing that was rejected
  // for being two SUBSTITUTIONS away (`simple` vs `staple`) starts matching.
  let prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let d = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    // Rotate three rows instead of two — the transposition term reads the row
    // before last, which a two-row rotation has already overwritten.
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare;
  }
  return prev[b.length];
}

/**
 * Distance a name of this length may drift and still be the same intent. Two
 * edits on a two-character name is every two-character name, so the budget
 * scales: a 3-char name must match exactly (case and plugin prefix aside), a
 * 6-char name gets one edit, longer names get two.
 */
function allowance(len: number): number {
  return len <= 3 ? 0 : len <= 6 ? 1 : 2;
}

/** Dispatch names carry an optional `plugin:` prefix the harness adds, not something a user types. */
const tail = (name: string): string => name.slice(name.lastIndexOf(":") + 1);

/**
 * Names that fired but match nothing installed, attributed to the installed
 * name they were probably aiming at — "invoked as `/impaccable` 2×", rendered
 * under the likely-intended skill.
 *
 * This renders as an accusation of a typo, so a false positive is worse than a
 * miss and the rules are deliberately mean:
 * - the budget above, applied to the shorter of the two names;
 * - a plugin-prefix-insensitive comparison, so `/brainstorming` reaches
 *   `superpowers:brainstorming` (the user typed the name they can see);
 * - a truncation rule for the longer names only — one is a prefix of the
 *   other, at least 6 shared characters, at most 6 dropped;
 * - built-in slash commands are never near misses: `/status` is a real
 *   command that did what the user asked, not a misspelling of anything;
 * - AMBIGUITY DROPS THE MATCH. A name equidistant from two installed skills
 *   would otherwise be printed under both, telling two owners the same fire
 *   was meant for them.
 *
 * Keyed by installed name, so exact-name collisions across scopes (which no
 * evidence can split anyway) share one entry.
 */
export function nearMissMap(
  installed: Iterable<string>,
  external: Iterable<{ name: string; count: number }>
): Map<string, { name: string; count: number }[]> {
  const names = [...new Set(installed)];
  const exact = new Set(names);
  const prepared = names.map((name) => ({ name, low: name.toLowerCase(), tailLow: tail(name).toLowerCase() }));
  const out = new Map<string, { name: string; count: number }[]>();

  for (const ext of external) {
    const raw = ext.name.startsWith("/") ? ext.name.slice(1) : ext.name;
    if (!raw || exact.has(raw) || exact.has(ext.name)) continue;
    const extLow = raw.toLowerCase();
    const extTail = tail(extLow);
    if (BUILTIN_COMMANDS.has(extLow) || BUILTIN_COMMANDS.has(extTail)) continue;

    let bestScore = Infinity;
    let winner: string | undefined;
    let tied = false;
    for (const cand of prepared) {
      let score = Infinity;
      for (const [a, b] of [
        [extLow, cand.low],
        [extTail, cand.tailLow],
      ]) {
        const max = allowance(Math.min(a.length, b.length));
        const d = editDistance(a, b, max);
        if (d <= max) {
          if (d < score) score = d;
          continue;
        }
        // Truncation/extension: `/brainstorm` for `brainstorming`. Scored
        // worse than any real edit-distance hit so it can never outrank one.
        if (a !== b && (a.startsWith(b) || b.startsWith(a))) {
          const shared = Math.min(a.length, b.length);
          const dropped = Math.max(a.length, b.length) - shared;
          if (shared >= 6 && dropped <= 6 && score > 3) score = 3;
        }
      }
      if (score === Infinity) continue;
      if (score < bestScore) {
        bestScore = score;
        winner = cand.name;
        tied = false;
      } else if (score === bestScore && cand.name !== winner) {
        tied = true;
      }
    }
    if (winner === undefined || tied) continue;
    out.set(winner, [...(out.get(winner) ?? []), { name: ext.name, count: ext.count }]);
  }

  for (const list of out.values()) {
    list.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return out;
}

// --- reference graph -------------------------------------------------------

/**
 * Ways one asset's body names another as something to DISPATCH. Bare word
 * occurrences are excluded on purpose: assets are named `run`, `audit` and
 * `shape` on a real machine, and "was disabling safe?" answered with "yes,
 * only 30 other skills mention the word shape" is worse than no answer.
 */
const REF_PATTERNS: RegExp[] = [
  // `/name` — a slash command as typed. The lookbehind keeps `docs/name` and
  // `https://host/name` out.
  /(?<![\w`/-])\/([A-Za-z][A-Za-z0-9:._-]*)/g,
  // A tool call as the transcript writes it: Skill(name), Task(name).
  /\b(?:Skill|Agent|Task)\(\s*["'`]?([A-Za-z0-9:._-]+)/g,
  // Prose in either order: "use the brainstorming skill", "the skill `foo`".
  /\b(?:the|a|an|use|uses|using|via|run|runs|invoke|invokes|call|calls|see)\s+["'`]?([A-Za-z0-9:._-]+)["'`]?\s+(?:skill|command|agent|subagent|sub-agent)\b/gi,
  /\b(?:skill|command|agent|subagent|sub-agent)\s+["'`]([A-Za-z0-9:._-]+)["'`]/gi,
  // A plugin-qualified dispatch name is distinctive enough to stand alone —
  // `superpowers:brainstorming` is never an incidental English word.
  /(?<![\w:./-])([A-Za-z][A-Za-z0-9_-]*:[A-Za-z][A-Za-z0-9_-]*)(?![\w:/-])/g,
];

/**
 * Which OTHER assets name this one — the warning that belongs beside a disable
 * toggle, because a skill nothing points at and a skill three others delegate
 * to are different decisions.
 *
 * Returns names, never paths: this feeds a browser payload, and the one-way
 * contract says the server resolves paths from ids, so a path in this map
 * would be a leak with no purpose.
 *
 * One pass per body over a fixed set of patterns, then a set intersection —
 * O(total body characters), not O(assets²), which is what makes it affordable
 * at 200 assets whose bodies each mention a few dozen tokens.
 */
export function referencedBy(assets: { name: string; body: string }[]): Map<string, string[]> {
  // Case-insensitive lookup: a body writing "the Brainstorming skill" means
  // the installed `brainstorming`. First registration wins where two installed
  // names differ only in case — an unresolvable pair, and picking one is
  // better than dropping the reference entirely.
  const canonical = new Map<string, string>();
  for (const a of assets) {
    const low = a.name.toLowerCase();
    if (!canonical.has(low)) canonical.set(low, a.name);
    const t = tail(low);
    if (!canonical.has(t)) canonical.set(t, a.name);
  }

  const refs = new Map<string, Set<string>>();
  for (const asset of assets) {
    if (!asset.body) continue;
    const body = asset.body.length > MAX_BODY_SCAN ? asset.body.slice(0, MAX_BODY_SCAN) : asset.body;
    for (const pattern of REF_PATTERNS) {
      for (const m of body.matchAll(pattern)) {
        const token = m[1];
        if (!token) continue;
        const target = canonical.get(token.toLowerCase());
        // A skill telling the reader how to invoke ITSELF is documentation,
        // not a dependency, and would make every self-documenting asset look
        // load-bearing.
        if (!target || target === asset.name) continue;
        const set = refs.get(target) ?? new Set<string>();
        set.add(asset.name);
        refs.set(target, set);
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [target, set] of refs) out.set(target, [...set].sort());
  return out;
}
