#!/usr/bin/env node
// Unit corpus for content health (src/health.ts). Every group below pins a
// behaviour that was deliberately NARROWED — the kind a refactor widens again
// without noticing, because widening makes no test fail unless one exists:
//   - resolveRefs answers UNDEFINED for a single-file asset (an agent/command
//     .md ships no bundled files, so every path in its body is prose); only a
//     directory-shaped asset can bundle a file and therefore fail to
//   - the rejection list: URLs, anchors, absolute/`~`/`@` paths, globs,
//     brace templates, `path/to/…`, ellipsis placeholders, root escapes — and
//     `checked`, the denominator, is present in every answer including zero
//   - nearMissMap scores OPTIMAL STRING ALIGNMENT, so one adjacent
//     transposition costs 1 (`stapel`→`staple`) while two substitutions on a
//     six-character name (`simple` vs `staple`) stay unmatched; the row renders
//     as an accusation of a typo, so the precision boundary IS the feature
//   - freshnessOf prefers git in a non-shallow repo, falls back to mtime, and
//     labels which evidence answered
//   - bodyHash normalizes re-save noise and nothing else
//   - referencedBy needs a dispatch-shaped mention, never a bare word
// Fixtures are COPIED to mkdtemp before use (the exec bit and a deliberately
// broken symlink cannot survive a checkout); the real $HOME is never read.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "health");
const { bodyHash, createHealthCache, freshnessOf, nearMissMap, referencedBy, resolveRefs } = await import(
  pathToFileURL(join(root, "dist", "health.js")).href
);

let failures = 0;
const ok = (n) => console.log(`  ok: ${n}`);
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
};
const tmps = [];
const freshDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `context-audit-health-${label}-`));
  tmps.push(d);
  return d;
};

// --- resolveRefs ------------------------------------------------------------
console.log("RESOLVEREFS (directory-shaped asset):");
const bundle = freshDir("refs");
cpSync(fixtures, bundle, { recursive: true });
const skillDir = join(bundle, "skill-dir");
// Mode bits and broken links are set here, not checked in: git normalizes the
// first and a copy would dereference the second.
chmodSync(join(skillDir, "scripts", "ok.sh"), 0o755);
chmodSync(join(skillDir, "scripts", "run.py"), 0o644);
chmodSync(join(skillDir, "scripts", "helper.py"), 0o644);
symlinkSync("does-not-exist.md", join(skillDir, "reference", "broken.md"));

const skillEntry = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const refs = resolveRefs({ path: skillDir, entry: skillEntry });
check("a directory-shaped skill gets a refs answer", refs !== undefined);
check(
  "the genuinely missing bundled file IS reported, with its entry-file line",
  refs?.missing.some((m) => m.path === "reference/missing.md" && m.line === 8),
  JSON.stringify(refs?.missing)
);
check(
  "a broken symlink counts as missing (statSync throwing is the point)",
  refs?.missing.some((m) => m.path === "reference/broken.md" && m.line === 9),
  JSON.stringify(refs?.missing)
);
check("exactly those two are missing", refs?.missing.length === 2, JSON.stringify(refs?.missing));
check("missing is ordered by entry-file line", refs?.missing[0].line < refs?.missing[1].line);
check(
  "checked is the denominator and is present",
  Object.prototype.hasOwnProperty.call(refs ?? {}, "checked") && refs.checked === 7,
  `checked=${refs?.checked}`
);

console.log("RESOLVEREFS (rejections — each one a false positive that was shipped once):");
const rejected = (label, needle) =>
  check(
    `rejected: ${label}`,
    !refs.missing.some((m) => m.path.includes(needle)) && !refs.notExecutable.some((m) => m.path.includes(needle)),
    JSON.stringify(refs.missing)
  );
// The absolute count above (7) is what makes these binding: a rejected token
// cannot quietly reappear inside `checked` either.
rejected("a URL in a markdown link", "example.com");
rejected("a bare anchor", "#overview");
rejected("an absolute path", "/usr/local");
rejected("a ~-rooted path", ".claude/skills/other");
rejected("an @-prefixed dispatch reference", "skills/testing");
rejected("a glob", "*.py");
rejected("a brace template", "{name}");
rejected("the path/to/ placeholder", "path/to");
rejected("an ASCII ellipsis segment", "task-3.md");
rejected("a unicode ellipsis segment", "task-4.md");
rejected("a path that escapes the asset root", "outside/secret.md");
check(
  "an anchor is STRIPPED, not treated as a different file — present.md dedupes to one",
  refs.checked === 7 && !refs.missing.some((m) => m.path.includes("present.md")),
  JSON.stringify(refs)
);
check(
  "a single-segment name that resolves is counted; one that does not is dropped, never reported missing",
  !refs.missing.some((m) => m.path === "package.json"),
  JSON.stringify(refs.missing)
);

console.log("RESOLVEREFS (exec bit):");
check(
  "a referenced script with a shebang and no exec bit is reported",
  refs.notExecutable.length === 1 && refs.notExecutable[0].path === "scripts/run.py" && refs.notExecutable[0].line === 11,
  JSON.stringify(refs.notExecutable)
);
check("an executable script is not reported", !refs.notExecutable.some((m) => m.path === "scripts/ok.sh"));
check(
  "a shebang-less helper is not reported — it is run as `python scripts/helper.py`",
  !refs.notExecutable.some((m) => m.path === "scripts/helper.py")
);

console.log("RESOLVEREFS (single-file assets ship no bundle):");
const agentPath = join(bundle, "agent.md");
const agentRefs = resolveRefs({ path: agentPath, entry: readFileSync(agentPath, "utf8") });
check(
  "an agent .md returns UNDEFINED — its body's paths are prose, not a bundle",
  agentRefs === undefined,
  JSON.stringify(agentRefs)
);
check(
  "the SAME body reports 2 missing as a directory and nothing as a file",
  resolveRefs({ path: join(skillDir, "SKILL.md"), entry: skillEntry }) === undefined && refs.missing.length === 2
);
check("no entry text ⇒ undefined, not an invented empty answer", resolveRefs({ path: skillDir }) === undefined);
check("a path that does not exist ⇒ undefined", resolveRefs({ path: join(bundle, "nope"), entry: skillEntry }) === undefined);

console.log("RESOLVEREFS (bounded work per row):");
{
  // 300 distinct references, none of which exist. The cap is what keeps one
  // pathological body from costing a thousand stat calls on a 200-asset scan;
  // it must cap the DENOMINATOR too, or `checked` would claim a number of
  // examinations that never happened.
  const many = Array.from({ length: 300 }, (_, i) => `- \`reference/gen-${i}.md\``).join("\n");
  const capped = resolveRefs({ path: skillDir, entry: many });
  check(
    "candidates are capped at 200, and `checked` reports the capped denominator",
    capped.checked === 200 && capped.missing.length === 200,
    `checked=${capped.checked} missing=${capped.missing.length}`
  );
}

console.log("RESOLVEREFS (nothing to check ≠ clean bill of health):");
const emptyDir = join(bundle, "empty-refs");
const emptyRefs = resolveRefs({ path: emptyDir, entry: readFileSync(join(emptyDir, "SKILL.md"), "utf8") });
check(
  "an entry naming no paths states checked: 0 rather than omitting the section",
  emptyRefs !== undefined && emptyRefs.checked === 0 && emptyRefs.missing.length === 0 && emptyRefs.notExecutable.length === 0,
  JSON.stringify(emptyRefs)
);

// --- freshnessOf ------------------------------------------------------------
console.log("FRESHNESS:");
let hasGit = false;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
  hasGit = true;
} catch {}
const git = (cwd, args, dates) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
    env: dates ? { ...process.env, GIT_AUTHOR_DATE: dates, GIT_COMMITTER_DATE: dates } : process.env,
  });

if (!hasGit) {
  ok("git-backed freshness (skipped: git not on PATH)");
} else {
  const repo = freshDir("repo");
  const tracked = join(repo, "skills", "tracked");
  mkdirSync(tracked, { recursive: true });
  writeFileSync(join(tracked, "SKILL.md"), "---\nname: tracked\n---\nBody.\n");
  const loneFile = join(repo, "agents", "solo.md");
  mkdirSync(dirname(loneFile), { recursive: true });
  writeFileSync(loneFile, "---\nname: solo\n---\nBody.\n");
  const dirty = join(repo, "skills", "dirty");
  mkdirSync(dirty, { recursive: true });
  writeFileSync(join(dirty, "SKILL.md"), "---\nname: dirty\n---\nBody.\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "add"], "2026-03-04T05:06:07Z");

  const trackedFresh = freshnessOf(
    { path: tracked, files: [join(tracked, "SKILL.md")] },
    createHealthCache()
  );
  check(
    "a committed skill in a non-shallow repo is dated by git, labelled git",
    trackedFresh?.source === "git" && trackedFresh?.editedAt === "2026-03-04T05:06:07.000Z",
    JSON.stringify(trackedFresh)
  );
  check(
    "git wins even though the checkout's mtime is newer, because git says the path is clean",
    trackedFresh?.editedAt === "2026-03-04T05:06:07.000Z"
  );
  const fileFresh = freshnessOf({ path: loneFile }, createHealthCache());
  check(
    "a single-file asset is dated by git too (pathspec is its basename)",
    fileFresh?.source === "git" && fileFresh?.editedAt === "2026-03-04T05:06:07.000Z",
    JSON.stringify(fileFresh)
  );

  // An uncommitted edit is the case the whole dirty probe exists for: the last
  // commit date would answer "unchanged since March" about a file edited today.
  writeFileSync(join(dirty, "SKILL.md"), "---\nname: dirty\n---\nEdited, not committed.\n");
  const dirtyFresh = freshnessOf({ path: dirty, files: [join(dirty, "SKILL.md")] }, createHealthCache());
  check(
    "an uncommitted edit falls back to mtime, labelled mtime",
    dirtyFresh?.source === "mtime" && Date.parse(dirtyFresh.editedAt) > Date.parse("2026-03-04T05:06:07Z"),
    JSON.stringify(dirtyFresh)
  );

  // A shallow clone's oldest commit is its clone horizon, not its history.
  const clone = join(freshDir("clone"), "checkout");
  let cloned = false;
  try {
    git(tmpdir(), ["clone", "-q", "--depth", "1", pathToFileURL(repo).href, clone]);
    cloned = true;
  } catch {}
  if (!cloned) ok("shallow-clone fallback (skipped: local clone unavailable)");
  else {
    const shallow = join(clone, "skills", "tracked");
    const shallowFresh = freshnessOf({ path: shallow, files: [join(shallow, "SKILL.md")] }, createHealthCache());
    check(
      "a shallow clone never dates an asset at its clone horizon — mtime, labelled mtime",
      shallowFresh?.source === "mtime",
      JSON.stringify(shallowFresh)
    );
  }
}

const norepo = freshDir("norepo");
const loose = join(norepo, "loose");
mkdirSync(loose, { recursive: true });
writeFileSync(join(loose, "SKILL.md"), "---\nname: loose\n---\nBody.\n");
const looseFresh = freshnessOf({ path: loose, files: [join(loose, "SKILL.md")] }, createHealthCache());
check(
  "outside any repository the answer is mtime, and it says so",
  looseFresh?.source === "mtime" && Date.parse(looseFresh.editedAt) > Date.parse("2026-01-01T00:00:00Z"),
  JSON.stringify(looseFresh)
);
check(
  "a path that does not exist has no freshness at all — never today, never 1970",
  freshnessOf({ path: join(norepo, "gone") }, createHealthCache()) === undefined
);
{
  // Pre-2000 stamps are the filesystem declining to answer, not a 26-year-old skill.
  const ancient = join(norepo, "ancient");
  mkdirSync(ancient, { recursive: true });
  const f = join(ancient, "SKILL.md");
  writeFileSync(f, "x");
  const when = new Date("1995-06-01T00:00:00Z");
  utimesSync(f, when, when);
  utimesSync(ancient, when, when);
  check(
    "a pre-2000 mtime is rejected rather than reported as an ancient edit",
    freshnessOf({ path: ancient, files: [f] }, createHealthCache()) === undefined,
    JSON.stringify(freshnessOf({ path: ancient, files: [f] }, createHealthCache()))
  );
}

// --- bodyHash ---------------------------------------------------------------
console.log("BODYHASH (re-save noise vs a real rewrite):");
const base = "# Title\n\nOne instruction.\n";
check("16 lowercase hex chars", /^[0-9a-f]{16}$/.test(bodyHash(base)), bodyHash(base));
const same = (label, other) => check(`same hash: ${label}`, bodyHash(base) === bodyHash(other), bodyHash(other));
same("CRLF line endings", base.replace(/\n/g, "\r\n"));
same("a lone-CR editor", base.replace(/\n/g, "\r"));
same("a BOM", "\uFEFF" + base);
same("trailing whitespace on each line", "# Title   \n\t\nOne instruction.  \n");
same("leading and trailing blank lines", "\n\n\n" + base + "\n\n");
const differs = (label, other) => check(`different hash: ${label}`, bodyHash(base) !== bodyHash(other));
differs("a case change", "# title\n\nOne instruction.\n");
differs("internal spacing", "# Title\n\nOne  instruction.\n");
differs("one changed word", "# Title\n\nOne directive.\n");
// Precomposed vs decomposed é — one editor on one OS re-saving the file, never a rewrite.
const nfc = "caf\u00e9 rules";
const nfd = "cafe\u0301 rules";
check(
  "NFD and NFC of the same text hash the same",
  nfc !== nfd && bodyHash(nfc) === bodyHash(nfd),
  `${bodyHash(nfc)} vs ${bodyHash(nfd)}`
);

// --- nearMissMap ------------------------------------------------------------
console.log("NEARMISS (the precision boundary IS the feature):");
const installed = ["staple", "impeccable", "superpowers:brainstorming", "run", "compare", "review-a", "review-b"];
const misses = nearMissMap(installed, [
  { name: "/stapel", count: 5 }, // adjacent transposition, 6 chars
  { name: "stalpe", count: 2 }, // adjacent transposition, 6 chars
  { name: "impaccable", count: 3 }, // one substitution, 10 chars
  { name: "simple", count: 4 }, // TWO substitutions, 6 chars — must not match
  { name: "/brainstorming", count: 6 }, // plugin prefix the user cannot see
  { name: "/brainstorm", count: 1 }, // truncation
  { name: "/compact", count: 9 }, // a real built-in that is 2 edits from `compare`
  { name: "/comapre", count: 2 }, // the same distance, but not a built-in
  { name: "/rum", count: 1 }, // 3 chars — must match exactly or not at all
  { name: "/staple", count: 8 }, // exact, prefixed
  { name: "review-c", count: 3 }, // equidistant from review-a and review-b
]);
const namesFor = (k) => (misses.get(k) ?? []).map((m) => m.name);
const anywhere = (n) => [...misses.values()].some((list) => list.some((m) => m.name === n));

check(
  "an adjacent TRANSPOSITION costs 1: `stapel` reaches `staple` (plain Levenshtein scored it 2 and missed)",
  namesFor("staple").includes("/stapel"),
  JSON.stringify([...misses])
);
check("`stalpe` transposes in the middle and still reaches `staple`", namesFor("staple").includes("stalpe"));
check("`impaccable` → `impeccable` (one substitution inside the 10-char budget)", namesFor("impeccable").includes("impaccable"));
check(
  "`simple` does NOT reach `staple` — two substitutions on a 6-char name, and a false positive here accuses the user of a typo",
  !anywhere("simple"),
  JSON.stringify([...misses])
);
check("the transposition allowance did not widen the substitution budget", namesFor("staple").length === 2, JSON.stringify(namesFor("staple")));
check("`/brainstorming` reaches `superpowers:brainstorming` — the user typed the name they can see", namesFor("superpowers:brainstorming").includes("/brainstorming"));
check("`/brainstorm` reaches it by truncation, ranked below the exact-tail hit", namesFor("superpowers:brainstorming")[0] === "/brainstorming");
check(
  "a built-in slash command is never a near miss, even when it is inside the budget of an installed name",
  !anywhere("/compact"),
  JSON.stringify([...misses])
);
check(
  "…and the guard is what excluded it: the same distance from a NON-built-in does match",
  namesFor("compare").includes("/comapre")
);
check("a 3-char name must match exactly: `/rum` reaches nothing", !anywhere("/rum"));
check("an exact name (slash-prefixed) is not a near miss of itself", !anywhere("/staple"));
check(
  "ambiguity drops the match — `review-c` is not printed under two owners",
  !anywhere("review-c") && !misses.has("review-a") && !misses.has("review-b"),
  JSON.stringify([...misses])
);
check("the map is keyed by INSTALLED name", [...misses.keys()].every((k) => installed.includes(k)), JSON.stringify([...misses.keys()]));
check("the typed name is preserved verbatim, slash and all", (misses.get("staple") ?? [])[0]?.name === "/stapel");
check(
  "entries sort by count desc",
  (misses.get("staple") ?? []).map((m) => m.count).join(",") === "5,2",
  JSON.stringify(misses.get("staple"))
);
check("an empty installed list produces an empty map, not a crash", nearMissMap([], [{ name: "/anything", count: 1 }]).size === 0);

// --- referencedBy -----------------------------------------------------------
console.log("REFERENCEDBY (a dispatch-shaped mention, never a bare word):");
const graph = referencedBy([
  { name: "staple", body: "Run /impeccable before shipping. See the audit skill." },
  { name: "impeccable", body: "This is /impeccable. Use `Skill(staple)` to finish." },
  {
    name: "audit",
    body: "Audit the shape of the layout. Read docs/audit.md and https://x.dev/staple, then superpowers:brainstorming.",
  },
  { name: "superpowers:brainstorming", body: "Delegate with Task(staple) and see superpowers:brainstorming for more." },
  { name: "shape", body: "Use the Staple skill when in doubt." },
  { name: "quiet", body: "" },
]);
check("`/impeccable` in prose is a reference", JSON.stringify(graph.get("impeccable")) === '["staple"]', JSON.stringify([...graph]));
check("\"the audit skill\" is a reference", JSON.stringify(graph.get("audit")) === '["staple"]');
check(
  "Skill(...) and Task(...) are references, sorted and deduped",
  JSON.stringify(graph.get("staple")) === '["impeccable","shape","superpowers:brainstorming"]',
  JSON.stringify(graph.get("staple"))
);
check("a plugin-qualified name stands alone", JSON.stringify(graph.get("superpowers:brainstorming")) === '["audit"]');
check("case-insensitive: \"the Staple skill\" reaches `staple`", (graph.get("staple") ?? []).includes("shape"));
check(
  "a BARE WORD is not a reference — `shape` is a real English word and 30 bodies use it",
  graph.get("shape") === undefined,
  JSON.stringify(graph.get("shape"))
);
check("`docs/audit.md` is a path, not a `/audit` dispatch", !(graph.get("audit") ?? []).includes("audit"));
check("a URL path segment is not a dispatch", !(graph.get("staple") ?? []).includes("audit"));
check("self-reference is documentation, not a dependency", !(graph.get("impeccable") ?? []).includes("impeccable"));
check("an empty body neither references nor is referenced", graph.get("quiet") === undefined);
check(
  "values are names, never paths (this feeds the browser payload)",
  [...graph.values()].every((list) => list.every((n) => !n.includes("/")))
);

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall health checks passed");
process.exit(failures ? 1 : 0);
