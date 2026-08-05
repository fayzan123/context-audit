#!/usr/bin/env node
/**
 * Builds the fabricated HOME behind the README hero image (docs/dashboard.png).
 *
 * This exists so the screenshot is never taken of a real machine. The hero has
 * to show a setup that is OVER the skill-listing budget with visible dead
 * weight, and the only inventories that look like that belong to actual people
 * — publishing one means publishing their skill names, project paths and usage
 * history to a README. A committed fixture makes the honest path also the easy
 * one, and makes the image reproducible: anyone can rebuild it and check that
 * the numbers on it are what the tool actually reports.
 *
 * Usage — from the repo root, after `npm run build`:
 *
 *   REPO=$PWD
 *   node scripts/make-demo-home.mjs /tmp/dev
 *   mkdir -p /tmp/dev/projects/app
 *   cd /tmp/dev/projects/app && HOME=/tmp/dev node "$REPO"/dist/index.js ui --no-open
 *
 * then screenshot the URL it prints. The flags matter and were arrived at by
 * trial:
 *
 *   chrome --headless --disable-gpu --force-device-scale-factor=2 \
 *          --window-size=1600,1120 --virtual-time-budget=4000 \
 *          --screenshot=docs/dashboard.png "<url>"
 *
 *   • force-device-scale-factor=2 — the README image is retina (3200×2240).
 *   • window-size 1600×1120 — tall enough that every row, the disabled skill
 *     and the plugin group all land above the fold with no scroll fade.
 *   • virtual-time-budget=4000 — the header readouts settle in on a staggered
 *     animation; without this the last one is captured mid-fade or missing.
 *
 * Tuning note: the listing budget is ~8,000 characters, and the fixture is
 * deliberately a MODEST number of skills with LONG descriptions rather than a
 * long list of short ones. That is how real setups go over (an over-specified
 * description is exactly what skillet exists to shrink), and it keeps the whole
 * story inside one viewport. Adding or trimming a sentence anywhere below moves
 * the headline percentage — check it with:
 *
 *   HOME=/tmp/dev node dist/index.js --json | grep listingChars
 *
 * (the dashboard reads a few points higher than the CLI, because it counts the
 * plugin's skills and the CLI does not inventory plugins at all).
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const HOME = process.argv[2];
if (!HOME) {
  console.error("usage: node scripts/make-demo-home.mjs <dir>   (e.g. /tmp/dev)");
  process.exit(2);
}
rmSync(HOME, { recursive: true, force: true });

const w = (p, content) => {
  const f = join(HOME, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
};

// Dates are relative to today so a regenerated hero never shows a stale window.
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const day = (daysAgo) => iso(daysAgo).slice(0, 10);

const SKILLS = [
  ["design-system-pro", "Use when building or reviewing UI components against the design system. Enforces the spacing scale, type ramp, color tokens, elevation levels and motion curves, and flags any hard-coded value that should reference a token instead. Covers React, Vue and plain CSS. Includes the new-component review checklist, the dark-mode contrast pass, and the rules for when a one-off deserves to be promoted into the system rather than copied a third time."],
  ["pdf-extractor", "Extract structured data from PDF documents — tables, form fields, invoice line items, signature blocks — with layout-aware parsing that survives multi-column pages, rotated scans and merged table cells. Falls back to OCR when a page carries no text layer, reconciles totals against line items, and emits CSV or JSON with a per-field confidence score so low-confidence extractions can be reviewed by hand. Preserves reading order across footnotes and sidebars, normalizes currency and date formats per document locale, and reports the pages it could not parse rather than returning a partial result that looks complete."],
  ["release-notes", "Generate release notes from merged pull requests and conventional commits between two git refs. Groups changes by type with breaking changes first, links each entry to its PR, credits contributors, and separates user-facing changes from internal refactors so the notes stay readable by people who do not read the diff. Handles monorepo scoping so a package's notes cover only its own commits, detects the previous tag automatically, rewrites terse commit subjects into sentences, and flags any breaking change that arrived without a migration note so it can be written before the release goes out."],
  ["sql-migrations", "Write and review database migrations: forward and rollback pairs, safe column drops behind a two-phase deploy, index creation without table locks, and backfill scripts that chunk large updates and can resume after a failure. Covers Postgres, MySQL and SQLite dialect differences, and states which steps are safe to run during traffic. Verifies the rollback actually restores the prior shape rather than merely running without error, and calls out any step whose duration scales with table size so it can be scheduled rather than discovered in production."],
  ["api-scaffold", "Scaffold a REST or GraphQL endpoint with request validation, typed responses, error envelopes, cursor pagination, auth middleware and an integration test, following the router conventions already present in the repository rather than introducing a second style alongside them. Wires the handler into the existing module registration, adds the OpenAPI entry, generates the client type, and writes the rate-limit and idempotency handling for any endpoint that mutates state so retries cannot double-charge."],
  ["csv-wrangler", "Clean and reshape CSV files: infer column types, normalize dates and currencies, deduplicate on composite keys, pivot and unpivot, and join across files. Reports every row it dropped and why, rather than silently discarding malformed input — the failure mode that makes a spreadsheet pipeline untrustworthy. Handles quoted delimiters, mixed encodings, BOM-prefixed headers and the trailing blank line that turns a clean import into an off-by-one, and writes a manifest recording every transformation applied so the output can be traced back to its source."],
  ["a11y-audit", "Audit an interface against WCAG 2.2 AA: keyboard traps, focus order and visible focus rings, contrast ratios including text over images, form labels and error association, landmark structure, and the ARIA attribute that should have been a native element instead. Produces findings ranked by how many users each one blocks. Distinguishes findings that block a user entirely from those that merely slow them down, checks the states a static scan cannot reach such as modal focus return and live-region announcement, and cites the specific success criterion each finding fails."],
  ["docker-debug", "Diagnose container problems: build cache misses, layer bloat, failing health checks, port and volume mount mistakes, DNS resolution inside compose networks, and OOM kills traced back to the process that grew. Ends with the smallest change that fixes it rather than a rewritten Dockerfile. Covers multi-stage build ordering, the difference between build-time and run-time environment variables, platform mismatches on Apple silicon, and the permission problems that only appear once a volume is mounted over a directory the image already populated."],
  ["commit-writer", "Write conventional-commit messages from the staged diff, inferring type and scope from the files touched and summarizing the actual behavior change rather than restating the diff in prose. Splits an unrelated change out into its own commit when the diff clearly contains two, keeps the subject under the line limit, writes a body only when the change needs justification, and adds the breaking-change footer whenever a public signature moved."],
  ["changelog", "Maintain CHANGELOG.md in Keep a Changelog format: move unreleased entries under a new version heading, link compare URLs on release, and keep the unreleased section grouped so it is writable throughout the cycle. Reconciles entries against merged pull requests so nothing user-facing ships unlisted, and rewrites internal wording into terms someone outside the team can act on."],
  ["flaky-hunter", "Find and fix flaky tests: shared state between cases, time and timezone assumptions, unawaited promises, ordering dependence, and the retry wrapper that hid a real bug for six months. Quantifies flake rate before and after so the fix is demonstrable, reruns the suite in randomized order to surface coupling, and isolates whether the failure follows the test or the machine it runs on."],
  ["perf-profiler", "Profile a slow page or endpoint end to end: flame graphs, N+1 queries, unbatched network waterfalls, layout thrash, bundle composition and the render passes that dominate frame time. Separates the cost that is on the critical path from the cost that merely appears in the profile, measures on a throttled device rather than a workstation, and finishes with the two changes worth making first and the number each is expected to move."],
  ["schema-designer", "Design relational schemas: normalization to the point it helps and no further, index strategy driven by the actual query set rather than by column popularity, constraint and cascade choices made explicitly, and the soft-delete decision taken deliberately instead of inherited. Covers tenancy isolation, enum versus lookup table, timestamp and timezone storage, and the migration path from whatever shape the data is in today."],
  ["test-writer", "Write tests that fail for the right reason: unit tests for pure logic, integration tests across real boundaries, fixtures that read as documentation, and explicit assertions rather than snapshots nobody reviews. Names each test after the behavior it protects, avoids mocking the thing under test, and covers the empty, single, many, and malformed cases that production will supply whether or not the suite does."],
  ["dep-updater", "Update dependencies safely: read changelogs for breaking changes, batch by risk rather than alphabetically, run the suite between batches, and stop at the first upgrade whose failure is not obviously mechanical. Distinguishes a security patch that must ship today from a major version that can wait for a quiet week, and leaves the lockfile in a state a reviewer can actually read."],
  ["log-triage", "Triage production logs and stack traces: cluster errors by root cause rather than message text, separate the trigger from the underlying defect, and reconstruct a reproduction from the surrounding request context. Identifies which errors are new since the last deploy, which are noisy but harmless, and which single fix would silence the largest share of the volume."],
  ["oncall-runbook", "Write runbooks an engineer can follow at 3am: symptoms first, decision tree second, exact commands with the output each should produce, and the escalation path for when the tree runs out. Assumes no prior context about the service, states which steps are safe to run during an incident and which need a second pair of eyes, and ends with what to capture for the review."],
];

for (const [name, description] of SKILLS) {
  w(`.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions for ${name}.\n`);
}

// One disabled skill, so the OFF state appears in the hero.
w(".claude/skills-disabled/screenshot-tester/SKILL.md",
  `---\nname: screenshot-tester\ndescription: Superseded by the visual-diff step in CI; kept until the old baselines are migrated off it.\n---\n\nOld runner.\n`);

// A plugin at a version the local marketplace checkout has moved past, so the
// hero shows the "2.2.0 listed" claim and the update button. Its skills count
// toward the listing exactly like the ones you installed yourself — the part
// people miss when a marketplace pack quietly doubles the budget.
const PLUG = ".claude/plugins/cache/acme-tools/toolbelt/2.1.0";
const PLUGIN_SKILLS = [
  ["pr-summarizer", "Summarize a pull request for reviewers: what changed and why, the risky hunks called out by file, and the manual verification the author already performed."],
  ["incident-timeline", "Reconstruct an incident timeline from logs, deploys and alerts, separating detection from cause and marking the decision points for the review."],
];
for (const [name, description] of PLUGIN_SKILLS) {
  w(`${PLUG}/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions.\n`);
}
w(`${PLUG}/commands/review-pr.md`, `---\ndescription: Review the current pull request against the team checklist and post inline comments.\n---\n\nReview it.\n`);
w(".claude/plugins/installed_plugins.json", JSON.stringify({
  version: 2,
  plugins: { "toolbelt@acme-tools": [{ scope: "user", installPath: join(HOME, PLUG), version: "2.1.0" }] },
}, null, 1));
w(".claude/settings.json", JSON.stringify({ enabledPlugins: { "toolbelt@acme-tools": true } }, null, 1));
w(".claude/plugins/marketplaces/acme-tools/.claude-plugin/marketplace.json",
  JSON.stringify({ name: "acme-tools", plugins: [{ name: "toolbelt", source: "./plugins/toolbelt" }] }, null, 1));
w(".claude/plugins/marketplaces/acme-tools/plugins/toolbelt/.claude-plugin/plugin.json",
  JSON.stringify({ name: "toolbelt", version: "2.2.0" }, null, 1));

// Transcripts. Only a handful of skills ever fire — the dead-weight story the
// hero exists to tell — spread across a six-week window.
const FIRES = [
  ["commit-writer", 31, 0],
  ["release-notes", 12, 1],
  ["toolbelt:review-pr", 4, 4],
  ["api-scaffold", 3, 6],
  ["changelog", 2, 8],
  ["docker-debug", 1, 24],
];
let session = 0;
for (const [skill, count, lastDaysAgo] of FIRES) {
  for (let i = 0; i < count; i++) {
    // One invocation per session file, so session counts look like real usage.
    const at = i === count - 1 ? lastDaysAgo : lastDaysAgo + 1 + (i % 30);
    w(`.claude/projects/demo-app/session-${String(session++).padStart(3, "0")}.jsonl`,
      JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: "…" } }) + "\n" +
      JSON.stringify({
        type: "assistant", timestamp: iso(at),
        message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
      }) + "\n");
  }
}
// Oldest transcript: the window start, so the header reads a six-week span
// rather than collapsing to a single day.
w(".claude/projects/demo-app/session-oldest.jsonl",
  JSON.stringify({ type: "user", timestamp: iso(42), message: { role: "user", content: "…" } }) + "\n");

console.log(`demo HOME built at ${HOME} — window ${day(42)} → ${day(0)}`);
console.log(`next: mkdir -p ${HOME}/projects/app && (cd ${HOME}/projects/app && HOME=${HOME} node <repo>/dist/index.js ui --no-open)`);
