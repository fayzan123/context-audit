# Multi-project scope — cost per session stops depending on where you launched

**Date:** 2026-08-07
**Status:** Approved design, pre-implementation
**Amends:** `2026-08-04-ui-dashboard-design.md` (the always-injected readout gains a range), `2026-08-06-dashboard-ui-overhaul-design.md` (one sidebar entry is added to ANALYSIS). Neither's honesty rules are relaxed; this spec is subject to all of them.

## What and why

The dashboard's loudest figure is the always-injected cost — `8,697 tok/session` on the machine this was designed against. It is true in the directory the server was launched from and false in most of the others the same user works in, and nothing on the page says so.

Measured with the real engine, run once per directory on the design machine:

| launch a Claude session in… | always-injected | over floor |
|---|---|---|
| `~/Contributon` | 16,302 | +7,605 (+87%) |
| `~/Desktop/School/3305_A3` | 10,365 | +1,668 |
| `~/Documents/GitHub/ClearCare` | 10,353 | +1,656 |
| `~/Documents/GitHub/site-scout` | 10,223 | +1,526 |
| `~/Desktop/School/Assignment-2` | 9,998 | +1,301 |
| `~/Documents/GitHub/dayforce-screening` | 8,744 | +47 |
| `~/Documents/GitHub/claude-workflow-composer` | 8,744 | +47 |
| `~/Documents/GitHub/chox` | 8,697 | +0 |
| `~/Documents/GitHub/context-audit` ← where the server ran | 8,697 | +0 |

Median addition **+1,301 (~15%)**; maximum **+7,605 (+87%)**. Five of nine projects add 15% or more. The figure the dashboard reported was the joint minimum.

**This is a correctness defect against the product's one rule, not a missing feature.** "Every line of output must be a fact the user can verify in ten seconds" is not satisfied by a number whose truth depends on the reader's shell location, with nothing on the page disclosing the dependency. The token savings that follow are a benefit; the disclosure is the reason.

A second fact falls out of the same work and is worth naming, because it is the "across your agents" question with data behind it for the first time: `claude-workflow-composer` carries a 5,579-token `AGENTS.md` and a 47-token `CLAUDE.md`; `chox` carries `AGENTS.md` and no `CLAUDE.md`; `dayforce-screening` carries both. Which repository speaks to which tool, and what each one costs, is currently unanswerable.

## The finding that sets the architecture

Every supported harness records the working directory of every session, and this codebase already reads all three stores:

| harness | where the path comes from | status |
|---|---|---|
| claude | `~/.claude/projects/*/*.jsonl` → `cwd` | verified on the design machine |
| codex | `~/.codex/sessions/**/*.jsonl` → `payload.cwd` | verified on the design machine |
| cursor | workspace storage → folder | **already parsed** — `workspaceProjects()`, `src/sources/cursordb.ts:301`, surfaced as `CursorRuleAttachment.project` |

The harnesses **disagree** about what the machine's projects are. On the design machine: claude knows 9, codex knows 16, the union is 19, of which 10 exist on disk. Six live projects are known only to codex; two only to claude.

**The most expensive project on the machine — `~/Contributon`, the +87% one — is known only to codex.** Claude has never run there. A claude-led discovery mechanism would miss the headline finding of the feature built to surface it.

Discovery is therefore per-adapter and unioned, not claude-first with others appended. This is the existing source-adapter contract applied to one more question, and it keeps a codex-only or cursor-only machine fully served.

## Decisions locked during brainstorming (2026-08-07)

1. **Discovery reads what the harnesses recorded; it never crawls the filesystem and never asks for configuration.** A crawl would have to guess a root, and the design machine's live projects span `~/Documents/GitHub/*`, `~/Desktop/School/*`, and `~` itself. There is no root to guess.
2. **The recorded `cwd` is the only accepted path source. Directory names are never decoded.** Claude's project directory encoding maps both `/` and `-` onto `-` and cannot be reversed: `-Users-…-context-audit` is equally `…/context-audit` and `…/context/audit`. Reading the transcript's own `cwd` is a reading; decoding the directory name is a guess, and this tool does not present guesses as measurements.
3. **Cost is reported as floor plus addition, never as one summed total.** Summing project costs across projects would state a figure no session ever pays.
4. **`AGENTS.md` cost is never folded into the claude figure.** It is a different harness's rent. The engine already separates them and the UI must not recombine them.
5. **A project the harness recorded but whose directory is gone keeps its fires and reports no cost.** The fires happened; the cost is unmeasurable, which is not zero.
6. **Scope of the sidebar change is one entry.** `projects` joins ANALYSIS. The INVENTORY section, the lens, and the table are untouched by this spec.

## Architecture

### The adapter contract gains one optional method

```ts
/** One directory a harness recorded working in. */
export interface ProjectRef {
  /** Absolute path, as the harness recorded it. Never decoded from a directory name. */
  path: string;
  /** ISO of the most recent session this harness recorded there. */
  lastSeen?: string;
  /** How many of this harness's sessions ran there. */
  sessions: number;
}

export interface SourceAdapter {
  // …existing members unchanged…
  /**
   * Directories this harness recorded working in. Optional exactly as `usage`
   * is: an adapter with no project record contributes nothing rather than a
   * fabricated entry. `agents-md` keeps no sessions and never implements it.
   */
  projects?(ctx: SourceContext): ProjectRef[];
}
```

### One new module

`src/projects.ts` — asks every adapter, unions by absolute path, and classifies. It owns no parsing of its own; each adapter reads its own store, as today.

```ts
export type ProjectState = "live" | "gone";

export interface FleetProject {
  path: string;
  /** Which harnesses recorded this directory, and what each recorded. */
  bySource: Partial<Record<SourceId, ProjectRef>>;
  /** Whether the directory exists now. Decides whether it can be priced. */
  state: ProjectState;
}

export function discoverProjects(ctx: AuditContext): {
  projects: FleetProject[];
  /** Entries no adapter could resolve to a path — reported, never dropped. */
  caveats: string[];
};
```

### The build loop

`buildUiPayload` computes the floor once and each live project once:

1. Run the existing engine against `{home, cwd: home}` to establish the **floor** — the user-scope cost paid in every session anywhere. `cwd === home` is precisely the condition under which `inventory.ts`'s scope test marks nothing project-scoped, so this yields user scope by construction rather than by filtering. Verified on 0.6.0: it returns 8,697 with `{skill: 49, agent: 110}` and no instruction file, matching the three project directories that add nothing. (The agent count fell from 133 when Part A stopped counting files that are not agent definitions; those rows carried no injected chars, so every cost figure in this spec is unchanged and was re-measured after that shipped.)
2. For each `live` project, run the existing engine against `{home, cwd: project.path}` and record only what that directory adds, per source.
3. `gone` projects are carried with their recorded sessions and **no cost figure**.

**No analyzer changes.** `contentFacts`, `securityScan` and the history readers are already parameterized by `SourceContext` and are called exactly as they are today. This is a loop over an existing entry point, which is why the change is tractable.

**The shared work must be hoisted, and this is a requirement rather than a property that falls out.** A naive loop re-walks the 164-item user-scope tree and re-reads 391 transcripts once per project — nine to nineteen times the current 2,837 ms. The user-scope discovery pass and the transcript/ledger read happen **once** and are passed into each per-project build; only per-directory instruction files are read per project. An implementation that calls the current entry point N times unchanged does not satisfy this spec.

The current directory is always processed first, so the page is useful before the fleet finishes.

### Payload additions

`UiPayload` gains one member, documented in the existing `types.ts` style:

```ts
/**
 * The machine's projects, and what a session in each one costs beyond the
 * floor. Absent when no adapter recorded any directory — a machine that has
 * only ever run in one place gets no fleet, not an empty one.
 */
fleet?: {
  /** Paid in every session anywhere: user-scope assets, by source. */
  floor: Partial<Record<SourceId, number>>;
  projects: FleetProjectCost[];
  /** Directories recorded but unresolvable, and why. */
  caveats: string[];
};
```

`FleetProjectCost` carries `path`, `state`, `bySource` (per-source addition **and** the instruction files producing it), and the recorded session counts. Cost is `undefined` on a `gone` project — never `0`.

## The three states

This is where the honesty of the feature lives; each state needs its own treatment and none may collapse into another.

- **live** — the directory exists. Priceable. Full row: floor + its own addition, per source.
- **gone** — the harness has history, the directory does not exist. On the design machine: a deleted `skill-audit` repository and four ephemeral `~/.chox/worktrees/*` directories. Fires are retained (they happened); cost renders as **unmeasurable**, which is a distinct rendering from zero and reuses the existing *unmeasured* deviation mark.
- **undecodable** — a harness kept a directory whose sessions carry no readable `cwd`. Fourteen of the design machine's twenty-three claude entries are in this state. These cannot be listed, so they are **counted in caveats**, exactly as the cursor store's unreadable records already are.

## The UI

Subject in full to `2026-08-06-dashboard-ui-overhaul-design.md`: say it once, define terms in the layout, one consistent deviation mark, and `.impeccable.md`'s hard-ban list.

### Stat bar

The always-injected figure becomes floor plus worst case:

```
8,697 everywhere · up to 16,302 in Contributon
```

When every project adds nothing, it renders as today's single figure — a range with one value is not drawn as a range. The figure is clickable and navigates to `projects`, like every other stat-bar figure.

### The `projects` view

A new ANALYSIS entry, present only when the fleet holds more than the current directory — the existing "an entry appears only when it has something to show" rule.

It opens with the question answered in a sentence, in the style the `listing` and `prune` views already use: what a session costs, where it costs most, and that the floor is paid everywhere. Then one row per project, most expensive first, carrying:

- path, with the current directory marked;
- per-source addition in its own column, so the claude and codex figures are never summed;
- the instruction files producing it;
- `gone` rendered as a state with its fires retained and its cost unmeasurable.

`AGENTS.md` sits in its own column. The engine separates claude and agents-md rent correctly today and the view must not recombine them.

### Definitions added to the layout

**floor** and **project addition** are defined where they first appear, in the layout, not in a tooltip — per the overhaul spec's teaching rule.

## Trust boundary, stated on the page

- **A project no harness has recorded is invisible.** No session was ever run there, so no store mentions it. The view states what it can see rather than implying completeness.
- **Token figures remain `chars / 4` estimates**, labelled as they are everywhere else. The *ratio* between floor and total is robust to estimator error in a way the absolute figure is not, because both ends are the same estimator; the view leads with the comparison for that reason.
- **A `gone` project's fires are real and its cost is unmeasurable.** Neither is silently converted into the other.

## Non-goals

Editing, creating, deleting or moving project instruction files. Cross-project or cross-agent copying (a separate, later piece of work). Toggling project-scoped assets — `toggle.ts`'s refusal to act outside `~/.claude/skills` and `~/.claude/agents` is unchanged and correct. Watching the filesystem for new projects. Any persisted project list, allow-list or configuration file. Remote or non-local projects.

## Risks

1. **Scan time multiplies.** Nine to nineteen engine invocations where there was one; the current scan is 2,837 ms. This is the largest implementation risk and it is not mitigated for free — see the hoisting requirement above. Sharing the user-scope walk and the transcript read leaves each project only its own handful of instruction files, which is the difference between a few hundred milliseconds and half a minute. The current directory renders first regardless, and if the fleet still lands slow it renders progressively; it never blocks first paint. **Measure before and after; a regression in first-paint time is a failure of this spec, not a cost of it.**
2. **A project that fails to scan disappears.** Any per-project failure becomes a stated error row, never a silent omission — the rule the plugin resolver already follows.
3. **The range is dominated by one file.** The design machine's maximum comes almost entirely from one 7,605-token `CLAUDE.md`. The view must show the distribution, not only the extreme, or it repeats in a new place exactly the misleading-by-selection failure this tool exists to prevent.
4. **The fleet reads as a file browser.** `projects` is a cost analysis with paths in it, not a directory tree. No tree, no disclosure triangles, no icons.

## Testing

- Fixture home with three fabricated projects across two providers: the union is correct and the overlapping project appears once.
- A `ProjectRef` whose directory does not exist renders `gone`, retains its fires, and reports no cost — asserted as "not `0`", not merely "falsy".
- A recorded directory with no readable `cwd` produces a caveat and no row.
- A machine whose adapters record exactly one directory produces **no** fleet and **no** sidebar entry.
- Directory-name decoding is never used: a fixture project at `…/context-audit` must resolve from its transcript `cwd`, and a test pins that a name-derived path is not accepted.
- **The arithmetic regression:** for every project, floor + that project's addition equals the total the engine reports when run against that directory independently. This was hand-verified nine times on the design machine and belongs in the suite.
- `agents-md` cost never appears inside a claude figure.
- Screenshots at 1512×900 and one narrow width, of the `projects` view and the amended stat bar, before the work is called done.
