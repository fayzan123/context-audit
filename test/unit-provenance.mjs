#!/usr/bin/env node
// Unit corpus for install-date provenance (src/provenance.ts):
//   - plugin chain: manifest installedAt (earliest entry, ISO or epoch-ms) →
//     oldest cache version-dir birthtime → first-seen, origin carried throughout
//   - user/codex skill chain: dir birthtime → SKILL.md birthtime → dir mtime →
//     first-seen, absent-dir tolerant
//   - repo skill chain: git first-add → dir birthtime → first-seen, with the
//     shallow-clone guard
//   - command/agent files: pack-cluster heuristic (≥5 sharing a birthtime second)
//   - guards: epoch/1970 birthtimes rejected; whole-inventory shared birthtime
//     (machine migration) disqualifies every birthtime link
// Everything runs against mkdtemp fake homes — the real $HOME is never read.
// Timing-sensitive files are built at runtime because git cannot carry
// birthtimes: on APFS, setting mtime BELOW birthtime drags birthtime down with
// it (and raising mtime leaves birthtime alone), which lets the test force
// exact creation seconds. Where the filesystem lacks that behavior the
// birthtime-forcing checks are skipped, visibly.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures", "provenance");
const { resolveProvenance } = await import(pathToFileURL(join(root, "dist", "provenance.js")).href);

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
  const d = mkdtempSync(join(tmpdir(), `context-audit-prov-${label}-`));
  tmps.push(d);
  return d;
};

const NOW = "2026-08-05T12:00:00.000Z";
const skillMd = readFileSync(join(fixtures, "SKILL.md"), "utf8");
const item = (id, path, extra = {}) => ({ id, source: "claude", kind: "skill", path, scope: "user", ...extra });
const iso = (ms) => new Date(ms).toISOString();
const force = (path, when) => utimesSync(path, when, when); // mtime below birthtime drags birthtime down (APFS)
const epoch = new Date(0);

// Capability probe: can this filesystem's birthtime be forced via utimes?
let canForce = false;
{
  const d = freshDir("probe");
  const f = join(d, "p");
  writeFileSync(f, "x");
  const t = new Date("2020-06-01T00:00:00Z");
  force(f, t);
  canForce = statSync(f).birthtimeMs === t.getTime();
}
const forced = (name, fn) => {
  if (canForce) fn();
  else ok(`${name} (skipped: birthtime not forceable on this filesystem)`);
};

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

// --- plugin chain -----------------------------------------------------------
console.log("PLUGIN CHAIN:");
{
  const home = freshDir("plugin");
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  cpSync(join(fixtures, "installed_plugins.json"), join(home, ".claude", "plugins", "installed_plugins.json"));
  const betaCache = join(home, ".claude", "plugins", "cache", "official", "beta");
  mkdirSync(join(betaCache, "1.0.0"), { recursive: true });
  mkdirSync(join(betaCache, "2.0.0"), { recursive: true });
  if (canForce) force(join(betaCache, "1.0.0"), new Date("2026-02-02T00:00:00Z"));

  const ctx = { home, cwd: home, now: NOW };
  const plug = (name) => ({ name, marketplace: "official" });
  const p = resolveProvenance(
    [
      item("p-alpha", join(home, "no-such-path"), { plugin: plug("alpha") }),
      item("p-gamma", join(home, "no-such-path"), { plugin: plug("gamma") }),
      item("p-beta", join(betaCache, "2.0.0"), { plugin: plug("beta") }),
      item("p-epoch", join(home, "no-such-path"), { plugin: plug("epoch") }),
      item("p-evil", join(home, "no-such-path"), { plugin: plug("../evil") }),
    ],
    ctx
  );

  const alpha = p.get("p-alpha");
  check(
    "manifest installedAt wins, earliest entry across versions",
    alpha?.source === "plugin-manifest" && alpha?.installedAt === "2026-01-15T00:00:00.000Z",
    JSON.stringify(alpha)
  );
  check("origin carries name@marketplace", alpha?.origin === "alpha@official", alpha?.origin);
  const gamma = p.get("p-gamma");
  check(
    "epoch-ms installedAt normalized to ISO",
    gamma?.source === "plugin-manifest" && gamma?.installedAt === "2025-01-01T00:00:00.000Z",
    JSON.stringify(gamma)
  );
  const beta = p.get("p-beta");
  const betaOldest = Math.min(
    statSync(join(betaCache, "1.0.0")).birthtimeMs,
    statSync(join(betaCache, "2.0.0")).birthtimeMs
  );
  check(
    "no installedAt falls to oldest cache version-dir birthtime",
    beta?.source === "birthtime" && beta?.installedAt === iso(betaOldest) && beta?.origin === "beta@official",
    JSON.stringify(beta)
  );
  if (canForce) {
    check("oldest cache dir is the forced older version", beta?.installedAt === "2026-02-02T00:00:00.000Z", beta?.installedAt);
  }
  const pe = p.get("p-epoch");
  check(
    "installedAt of 0 rejected — falls to first-seen, origin kept",
    pe?.source === "first-seen" && pe?.installedAt === NOW && pe?.origin === "epoch@official",
    JSON.stringify(pe)
  );
  check("traversal-shaped plugin name resolves without escaping the cache", p.get("p-evil")?.source === "first-seen");
}

// --- user-level (and codex) skill chain ------------------------------------
console.log("USER SKILL CHAIN:");
{
  const home = freshDir("user");
  const skills = join(home, ".claude", "skills");
  const mkSkill = (name) => {
    const d = join(skills, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), skillMd);
    return d;
  };
  const foo = mkSkill("foo");
  const bar = mkSkill("bar");
  const baz = mkSkill("baz");
  const qux = mkSkill("qux");
  if (canForce) {
    force(bar, epoch); // dir birth 1970, SKILL.md untouched
    force(baz, epoch);
    force(join(baz, "SKILL.md"), epoch);
    utimesSync(join(baz, "SKILL.md"), new Date("2026-04-02T00:00:00Z"), new Date("2026-04-02T00:00:00Z"));
    utimesSync(baz, new Date("2026-04-01T00:00:00Z"), new Date("2026-04-01T00:00:00Z")); // mtime up, birth stays 1970
    force(qux, epoch);
    force(join(qux, "SKILL.md"), epoch); // every link dead: birth 1970, mtime 1970
  }

  const ctx = { home, cwd: home, now: NOW };
  const p = resolveProvenance(
    [
      item("u-birth", foo),
      item("u-skillmd", bar),
      item("u-mtime", baz),
      item("u-first", qux),
      item("u-ghost", join(home, ".codex", "skills", "ghost"), { source: "codex" }),
      item("u-seen", join(home, ".codex", "skills", "gone"), { source: "codex", firstSeen: "2026-05-01T00:00:00.000Z" }),
    ],
    ctx
  );

  const fooSt = statSync(foo);
  const birth = p.get("u-birth");
  check(
    "dir birthtime wins when valid",
    birth?.source === "birthtime" && birth?.installedAt === iso(fooSt.birthtimeMs),
    JSON.stringify(birth)
  );
  forced("1970 dir birthtime rejected, SKILL.md birthtime is the next link", () => {
    const smBirth = statSync(join(bar, "SKILL.md")).birthtimeMs;
    const r = p.get("u-skillmd");
    check(
      "1970 dir birthtime rejected, SKILL.md birthtime is the next link",
      r?.source === "birthtime" && r?.installedAt === iso(smBirth),
      JSON.stringify(r)
    );
  });
  forced("both birthtimes dead — dir mtime, labeled by source", () => {
    const r = p.get("u-mtime");
    check(
      "both birthtimes dead — dir mtime, labeled by source",
      r?.source === "mtime" && r?.installedAt === "2026-04-01T00:00:00.000Z",
      JSON.stringify(r)
    );
  });
  forced("every filesystem link dead — first-seen at injected now", () => {
    const r = p.get("u-first");
    check(
      "every filesystem link dead — first-seen at injected now",
      r?.source === "first-seen" && r?.installedAt === NOW,
      JSON.stringify(r)
    );
  });
  const ghost = p.get("u-ghost");
  check(
    "absent codex skills dir tolerated — first-seen, no throw",
    ghost?.source === "first-seen" && ghost?.installedAt === NOW,
    JSON.stringify(ghost)
  );
  const seen = p.get("u-seen");
  check(
    "caller-supplied ledger first-seen beats now",
    seen?.source === "first-seen" && seen?.installedAt === "2026-05-01T00:00:00.000Z",
    JSON.stringify(seen)
  );
}

// --- repo skill chain -------------------------------------------------------
console.log("REPO SKILL CHAIN:");
if (!hasGit) {
  ok("repo chain (skipped: git not on PATH)");
} else {
  const repo = freshDir("repo");
  const skill = join(repo, "skills", "deploy");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), skillMd);
  git(repo, ["init", "-q"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "add skill"], "2026-02-03T04:05:06Z");
  writeFileSync(join(skill, "SKILL.md"), skillMd + "\nEdited.\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "edit skill"], "2026-07-07T07:07:07Z");

  const clone = join(freshDir("clone"), "checkout");
  let cloned = false;
  try {
    git(tmpdir(), ["clone", "-q", "--depth", "1", pathToFileURL(repo).href, clone]);
    cloned = true;
  } catch {}

  const norepo = freshDir("norepo");
  const loose = join(norepo, "loose-skill");
  mkdirSync(loose);
  writeFileSync(join(loose, "SKILL.md"), skillMd);

  const ctx = { home: freshDir("repo-home"), cwd: repo, now: NOW };
  const items = [
    item("r-git", skill, { scope: "project" }),
    item("r-norepo", loose, { scope: "project" }),
  ];
  if (cloned) items.push(item("r-shallow", join(clone, "skills", "deploy"), { scope: "project" }));
  const p = resolveProvenance(items, ctx);

  const rg = p.get("r-git");
  check(
    "git first-add wins — the ADD date, not the later edit",
    rg?.source === "git" && rg?.installedAt === "2026-02-03T04:05:06.000Z",
    JSON.stringify(rg)
  );
  const rn = p.get("r-norepo");
  check(
    "outside any repo — dir birthtime is the next link",
    rn?.source === "birthtime" && rn?.installedAt === iso(statSync(loose).birthtimeMs),
    JSON.stringify(rn)
  );
  if (cloned) {
    const rs = p.get("r-shallow");
    check(
      "shallow clone guard — truncated history never dates the skill",
      rs?.source === "birthtime",
      JSON.stringify(rs)
    );
  } else {
    ok("shallow clone guard (skipped: local file:// clone unavailable)");
  }
}

// --- pack-cluster heuristic -------------------------------------------------
console.log("PACK CLUSTER:");
forced("pack-cluster suite", () => {
  const home = freshDir("pack");
  const commands = join(home, ".claude", "commands");
  mkdirSync(commands, { recursive: true });
  const packSec = new Date("2026-03-10T16:27:20Z");
  const cmdItems = [];
  for (let i = 1; i <= 6; i++) {
    const f = join(commands, `c${i}.md`);
    writeFileSync(f, "# c\n");
    force(f, packSec);
    cmdItems.push(item(`cmd-${i}`, f, { kind: "command" }));
  }
  const agents = join(home, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  const solo = join(agents, "solo.md");
  writeFileSync(solo, "# a\n");
  const prompts = join(home, ".codex", "prompts");
  mkdirSync(prompts, { recursive: true });
  const ship = join(prompts, "ship.md");
  writeFileSync(ship, "# p\n");
  force(ship, packSec);
  const skillDir = join(home, ".claude", "skills", "foo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMd);

  const ctx = { home, cwd: home, now: NOW };
  const items = [
    ...cmdItems,
    item("agent-solo", solo, { kind: "agent" }),
    item("prompt-ship", ship, { source: "codex", kind: "prompt" }),
    item("skill-foo", skillDir),
  ];
  const p = resolveProvenance(items, ctx);

  const first = p.get("cmd-1");
  check(
    "≥5 files in one birthtime second read as a pack install",
    first?.source === "birthtime" &&
      first?.installedAt === "2026-03-10T16:27:20.000Z" &&
      first?.origin === "pack (6 files)",
    JSON.stringify(first)
  );
  check(
    "every cluster member carries the same pack date",
    cmdItems.every((it) => p.get(it.id)?.installedAt === "2026-03-10T16:27:20.000Z" && p.get(it.id)?.origin === "pack (6 files)")
  );
  const lone = p.get("agent-solo");
  check(
    "a lone file keeps its own birthtime, no pack label",
    lone?.source === "birthtime" && lone?.installedAt === iso(statSync(solo).birthtimeMs) && lone?.origin === undefined,
    JSON.stringify(lone)
  );
  const pr = p.get("prompt-ship");
  check(
    "prompts share the second but never join the command/agent cluster",
    pr?.source === "birthtime" && pr?.installedAt === "2026-03-10T16:27:20.000Z" && pr?.origin === undefined,
    JSON.stringify(pr)
  );

  const again = resolveProvenance(items, ctx);
  check(
    "resolution is deterministic — identical map on a second run",
    JSON.stringify([...p.entries()]) === JSON.stringify([...again.entries()])
  );
});

// --- migration guard --------------------------------------------------------
console.log("MIGRATION GUARD:");
forced("migration guard suite", () => {
  const home = freshDir("migrate");
  const commands = join(home, ".claude", "commands");
  mkdirSync(commands, { recursive: true });
  const shared = new Date("2026-05-05T05:05:05Z");
  const items = [];
  for (let i = 1; i <= 5; i++) {
    const f = join(commands, `m${i}.md`);
    writeFileSync(f, "# m\n");
    force(f, shared);
    items.push(item(`mig-cmd-${i}`, f, { kind: "command" }));
  }
  const skillDir = join(home, ".claude", "skills", "moved");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMd);
  force(skillDir, shared);
  items.push(item("mig-skill", skillDir));
  // One file was genuinely edited after the migration: its mtime left the
  // shared second, so it is a real last edit and must survive as evidence.
  utimesSync(join(commands, "m1.md"), new Date("2026-06-06T06:06:06Z"), new Date("2026-06-06T06:06:06Z"));

  const ctx = { home, cwd: home, now: NOW };
  const p = resolveProvenance(items, ctx);

  check(
    "whole-inventory shared birthtime disqualifies every birthtime link",
    items.every((it) => p.get(it.id)?.source !== "birthtime"),
    JSON.stringify([...p.entries()])
  );
  check(
    "no pack label survives a migration",
    items.every((it) => p.get(it.id)?.origin === undefined)
  );
  check(
    "mtime inside the migration second is the copy, not an edit — first-seen",
    p.get("mig-cmd-2")?.source === "first-seen" && p.get("mig-cmd-2")?.installedAt === NOW,
    JSON.stringify(p.get("mig-cmd-2"))
  );
  const edited = p.get("mig-cmd-1");
  check(
    "mtime outside the migration second survives as a labeled last edit",
    edited?.source === "mtime" && edited?.installedAt === "2026-06-06T06:06:06.000Z",
    JSON.stringify(edited)
  );
  check(
    "migrated skill dir falls to first-seen too",
    p.get("mig-skill")?.source === "first-seen"
  );
  check("map covers every item", items.every((it) => p.has(it.id)));
});

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall provenance checks passed");
process.exit(failures ? 1 : 0);
