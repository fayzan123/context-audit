# Skill usage ledger + metrics — durable, provider-tagged usage tracking

**Date:** 2026-08-05
**Status:** Implemented. S1 (ledger core) 2026-08-05; S2 (joins + portfolio views) and S3 (Cursor ingestion + long tail) 2026-08-06. Sections below carry inline notes where implementation settled a question the design left open or turned up a limit the design did not anticipate.

## What and why

Usage tracking is this product's stated moat, and today it evaporates: Claude Code deletes transcripts after `cleanupPeriodDays` (default 30 — confirmed empirically, oldest surviving transcript is ~30 days old), so the dashboard can only ever say "6 fires in 42d," never "142 fires since March." This feature adds a **durable local usage ledger** that accumulates invocation events across scans, an **opt-in hooks channel** for exact real-time capture, and a **full metric surface** on the dashboard: every question a skill owner asks — do I use it, does the model find it, what does it cost per use, when did I install it, did my edit fix it, is it broken, who uses it, where — answered with a verifiable fact.

Explicitly rejected mechanism: appending "increment a counter" instructions to skill bodies. Counts would depend on model compliance (non-deterministic — violates the product creed), the tool's own security lens flags exactly that write-outside-yourself pattern, it inflates every skill's token cost, and passive assets (AGENTS.md, `alwaysApply` rules, CLAUDE.md) never "run" so they could never be counted. The harnesses already emit deterministic invocation records; we read those instead.

## Decisions locked during brainstorming (2026-08-05)

1. **Mechanism: ledger + opt-in hooks** (chosen over ledger-only and over counter-lines-in-skills). Scan-time ingestion is always on and needs zero setup; hooks close the >30-day-gap loss window for users who opt in.
2. **No daemons, no watchers.** Ledger writes happen inside the existing scan (`rescan is a button` stays locked) and inside harness-fired hooks. Nothing resident.
3. **Nothing leaves the machine; no new dependencies.** The ledger is plain JSONL under the user's home, written with `node:fs`. No SQLite, no network.
4. **Facts, not judgment — extended to usage.** No scores, no health grades. Every metric below is a count, a date, a ratio of counts, or a join of facts, each carrying its observation window. LLM-judged metrics (post-fire correction, "should have fired") are out of scope for the default scan, permanently.
5. **Cursor: schema-ready, ingestion deferred.** Cursor's `state.vscdb` records rule attachment per message (`cursorRules` on every bubble — verified), but the schema is undocumented and this machine has no `.cursor/rules` to validate against. The ledger's `provider` field supports `cursor` from day one; the ingester ships as a fast-follow. Until then the UI keeps its honest "no readable history."

   **Shipped in S3 (2026-08-06).** The ingester reads `cursorDiskKV` read-only through `node:sqlite`, feature-gated behind a dynamic import so Node < 22.13 degrades to "no readable history" rather than crashing — `engines` stays `>=18`. Rule attachments become `channel: "load"` events (a rule attached to a message is a passive load, not a dispatch). Three facts constrain what may be claimed from this store, and each is surfaced as a caveat rather than absorbed silently:
   - **Timestamps are per-conversation, not per-message.** Bubbles carry none; `composerData.createdAt` is the only date, so every attachment in one conversation shares it.
   - **The element shape of a `cursorRules` entry is unverified.** Every record on the reference machine is an empty array, so the parser accepts several plausible shapes and *counts* anything it cannot name as unparsed instead of guessing.
   - **Project attribution is best-effort**, resolved through `workspaceStorage/<hash>/workspace.json`; the shortfall is reported ("resolved 2 of 3 workspaces"), never rounded up.

   The store is undocumented and unversioned, so any shape surprise degrades the whole read to "no readable history" with a stated reason. Rule rows are marked dispatch-tracked *only* when the store actually read — a degraded read leaves them honestly untracked rather than showing a fabricated zero.
6. **Agent usage tracking rides the same ledger.** `Agent`/`Task` tool_use blocks record `input.subagent_type` (verified) — this closes the recorded Session-3 gap "no agent usage tracking, can't prove which of 272 agents are dead." Agent launches are ledger events with `kind: "agent"`.

## The ledger

Location: `~/.context-audit/usage/` (its own dotdir — the ledger is multi-provider, so it does not live under `~/.claude`).

- `events-YYYY-MM.jsonl` — append-only, one JSON object per event:

  ```json
  {
    "v": 1,
    "id": "<dedupe key>",
    "ts": "2026-08-05T18:33:05.000Z",
    "provider": "claude | codex | cursor",
    "kind": "skill | command | agent | prompt | rule | instructions",
    "name": "<dispatch name as the harness used it>",
    "channel": "auto | typed | load",
    "outcome": "ok | error | rejected",
    "interrupted": false,
    "sessionId": "…",
    "project": "/abs/cwd",
    "agent": { "id": "a868d…", "type": "general-purpose" },
    "model": "claude-fable-5",
    "entrypoint": "cli | sdk-cli",
    "caller": "direct",
    "src": { "file": "/abs/transcript.jsonl", "line": 1234 },
    "backfill": true
  }
  ```

  `agent`, `model`, `entrypoint`, `caller`, `src`, `backfill`, `outcome` are optional — absent when the source doesn't carry them. **Never stored:** message content, prompt text, or skill args (args may contain sensitive text; store nothing but the dispatch token).

- `meta.json` — `{ schemaVersion, trackedSince }`.
- `provenance.json` — install-date snapshot per item id, captured at first sighting (see Install dates below). Snapshotting matters because the filesystem evidence decays (plugin caches get pruned, transcripts get deleted); whatever the best source said at first scan is preserved.
- `snapshots.jsonl` — one line per audit run: `{ ts, items, enabled, injectedChars, byProvider }`. Powers "since last scan" deltas and the owned-vs-fired growth view. Tiny (one line per run).

**Dedupe keys** (ingestion and hooks converge on the same ids, so double-capture collapses):
- Skill/Agent tool_use → `sessionId + toolUseId`.
- Typed command (transcript `<command-name>`) → `sessionId + ts + name`.
- Passive load (AGENTS.md into a Codex session) → `sessionId + name`.
- Backfilled typed command (history.jsonl) → same rule as typed, but the importer only ingests events for sessionIds that contributed **no** transcript-derived events — clean, deterministic, no timestamp-tolerance matching.

**Window honesty upgrade, not violation:** lifetime numbers are labeled "since tracking began YYYY-MM-DD" (from `meta.trackedSince`, or the backfill horizon where backfill ran). "None in 42d" language stays for the transcript window; the two windows are never conflated.

## Capture — three writers, one format

### 1. Scan-time ingestion (always on, zero setup)

Each adapter's existing `usage()` pass emits raw events; a new ingest step appends the ones whose ids the ledger lacks. Every scan banks the currently-visible window before the harness deletes it.

- **Claude:** the walk over `~/.claude/projects` MUST be recursive and include `<project>/<sessionId>/subagents/agent-*.jsonl` — verified: Skill calls occur inside sidechains (1 of 36 on this machine), and subagent transcripts carry `isSidechain: true`, `agentId`, `attributionAgent` per line. Per event, also read: `message.model` (skip `"<synthetic>"` lines), top-level `entrypoint`, `caller.type` on the tool_use, and the outcome — `toolUseResult.success !== true` or `tool_result.is_error` ⇒ `error`; the literal string `toolUseResult: "User rejected tool use"` ⇒ `rejected`. Agent launches: match tool_use names `Agent` **and** `Task` (CLI versions differ), `name = input.subagent_type`, `channel: "auto"`, and `toolUseResult.agentId` links the launch to its subagent transcript.
- **Codex:** rollouts under `~/.codex/sessions/YYYY/MM/DD/` reach back to 2026-03-03 on this machine (they are not purged on the 30-day cycle — but we bank them anyway). AGENTS.md loads are exact: the synthetic user message beginning `# AGENTS.md instructions for <dir>` names the file's directory ⇒ `channel: "load"` events. Codex skills: SKILL.md reads in tool-call args. Session→repo attribution via `state_5.sqlite`'s `threads` table where present, else `session_meta.cwd`.
- **Fires attribution fix:** events are keyed `(provider, kind, name)` — and the dispatch name is recorded exactly as the harness used it, which retires the recorded frontmatter-name-vs-dirName double-counting pitfall (sessions.md:343). Exact-name collisions across scopes (user skill vs plugin skill vs project skill) cannot be split by any transcript evidence; both rows get a collision warning saying so (see catalog).

### 2. Hooks (opt-in, exact, real-time)

`context-audit hooks install` / `hooks uninstall` — prints the exact settings diff before writing, never auto-installs.

- **Claude Code:** `PostToolUse` matcher `^Skill$` **plus** `UserPromptExpansion` — verified: user-typed `/commands` never produce a Skill tool_use, so PostToolUse alone undercounts the typed channel. Also `^(Agent|Task)$` for agent launches. Hook stdin payloads (session_id, cwd, tool_name, tool_input, tool_use_id) pipe to `context-audit log-event`, which validates and appends.
- **Codex:** same events via `~/.codex/hooks.json` (hooks engine stable since v0.124.0).

  **Shipped in S3 (2026-08-06), with one deliberate narrowing.** The file shape was verified empirically against codex-cli 0.144.4 by writing candidate files and asking the harness what it registered (`codex app-server` → `hooks/list`), because guessing here fails silently:

  ```json
  { "description": "…", "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "…" } ] } ] } }
  ```

  The top level is an object with `description` and `hooks` — not the event map directly — and event keys are **PascalCase**. `snake_case` keys parse *without a warning* and register **zero** hooks, so the wrong casing would have produced a tool that reported success and captured nothing. Registered hooks arrive `trustStatus: "untrusted"`: Codex prompts the user to review and trust them on next start, and they do not run until then — the install output says so, because a capture channel the user believes is live but isn't is worse than none.

  **Only `UserPromptSubmit` is installed.** Codex has no dedicated skill-dispatch tool — its one tool is `exec`, and SKILL.md reads ride inside shell arguments — so a `PostToolUse` hook would spawn a process on *every shell command* to recover a signal the rollout scan already reads exactly. And Codex does not purge rollouts (they reach back to March on the reference machine), so the >30-day loss window that justifies hooks for Claude does not exist here. The cost is real and the benefit is not.

  The Codex hook's clock cannot match the rollout scan's timestamp, so the two ids do **not** collapse the way a `tool_use` id does. What prevents double counting is the session-level exclusion — which had to be generalized from `sessionId` to `(provider, sessionId)`, in both the CLI and the dashboard copies, or a Codex hooks user would have had every typed prompt counted twice.

### 3. Backfill import (one-time, on first scan or `context-audit backfill`)

`~/.claude/history.jsonl` survives the 30-day purge — verified: 5,038 entries spanning 2026-02-26 → 2026-08-05 (~5.3 months vs ~6 weeks of transcripts), each `{display, pastedContents, timestamp(epoch-ms), project, sessionId}`. It recovers the **typed channel only**. The importer's cleaning rules (all verified against real data):

1. Per entry, split `display` on newlines, take the first token of the first line; accept only `^\/[A-Za-z][A-Za-z0-9:_-]*$` (rejects pasted absolute paths and anchor fragments — both observed; `:` is admitted so rule 4's plugin dispatch names like `/superpowers:brainstorming` remain matchable).
2. Classify against a built-ins allowlist (`/usage /status /model /exit /clear /compact /effort /login /config /context /resume /continue /mcp /doctor /permissions /plugins /plugin /voice /rate-limit-options`) — built-ins are recorded with `kind: "command"` only if the user opts in; by default they are dropped (3,043 of 3,179 slash entries here are built-ins).

   **Resolved in S2 (2026-08-06) — the rule is symmetric across all three writers.** As first built this was a *backfill* rule, so the same `/usage` fire was dropped when imported from history.jsonl and banked when seen by the transcript scan or a hook: the count depended on which channel happened to observe it. The gate now lives at the one place every writer passes through — `ledger.appendEvents` drops typed-channel Claude built-ins — and the opt-in is a **durable ledger preference** (`meta.includeBuiltins`) rather than a CLI flag, because a flag on `backfill` can never reach a hook firing inside someone else's session. `backfill --include-builtins` / `--no-include-builtins` set that stored preference; `appendEvents` reports `droppedBuiltins` separately from `skipped` so the two reasons are never conflated.

   Two scoping decisions worth stating: the gate applies only to `channel: "typed"` (an auto or load event named `compact` is not a slash command), and only to `provider: "claude"` (the list is Claude Code's; a Codex prompt legitimately named `status` is a real asset that joins to a real row, and dropping it would be a silent undercount of something that exists). The append-only store is never rewritten, so flipping the preference off does not retract built-ins banked while it was on.
3. Drop sessions whose entries are 100% built-ins — this kills automation pollution (a ~10.8-minute-cadence `/usage` poller accounts for 2,594 entries and 2,918 of 3,147 sessions on this machine).
4. Remaining tokens match against installed skills/commands/plugin dispatch names; unmatched tokens (typos, renamed, deleted — 8 distinct here) are kept as `name` with no inventory join, surfacing in the existing external-fires bucket.
5. Backfilled events are flagged `backfill: true` and the UI labels the extended horizon: "typed-channel history extends to 2026-02-26 (backfilled); model-invoked history begins 2026-06-24."

`~/.codex/history.jsonl` is **not** a viable source (46 lines, 4 days, no command channel) — Codex backfill comes from the rollouts themselves, which already reach March.

## Install dates (provenance)

Fallback chains per asset class, verified on this machine (APFS, so `st_birthtime` is real). The winning value and its source label are snapshotted into `provenance.json` at first sighting.

| Asset class | Chain (first hit wins) |
|---|---|
| Plugin skill/command/agent | `installed_plugins.json` v2 `installedAt` (survives updates; `lastUpdated` = current version since) → oldest cache version-dir birthtime (labeled under-estimate — caches get pruned) → ledger first-seen |
| User-level skill | dir `st_birthtime` → `SKILL.md` birthtime → dir mtime (labeled "last edit") → ledger first-seen |
| Repo skill | `git log --follow --diff-filter=A` first-add of SKILL.md → dir birthtime (= arrived-on-machine) → ledger first-seen |
| Command/agent file | file birthtime with the **pack-cluster heuristic**: ≥5 files sharing one birthtime second ⇒ report as pack install date, not per-file (verified: 127/133 agent files share 2026-03-10 16:27:20) → mtime → ledger first-seen |
| Codex skill | same as user-level, rooted at `~/.codex/skills` (absent-dir tolerant) |

Guards: reject 1970 birthtimes; `git rev-parse --is-shallow-repository` before trusting git dates; a whole-inventory shared birthtime = machine migration, fall back to ledger first-seen.

## Metric catalog

Organization: **the question a user asks → the fact that answers it → exact source → where it lives.** Stages: **S1** = ledger core release, **S2** = joins & portfolio views, **S3** = Cursor ingestion + long-tail. Sources named here were all verified to exist; computation is deterministic throughout.

### Do I use this? (activity)

| Question | Fact shown | Source | Display | Stage |
|---|---|---|---|---|
| How often, ever and lately? | Fires: lifetime since trackedSince + window count | ledger count / transcript window | Table `fires` cell: "42 · 6 in 30d"; header window caption | S1 |
| When last / first? | last fired, first fired | ledger min/max ts | Table column (exists) + drawer | S1 |
| Is use rising or dying? | Weekly bins → rising / flat / quiet / new | ledger ts bucketing | Trend glyph on fires cell; dot-strip per week in drawer | S1 |
| Why did it go quiet? | "last fired 31d ago — around when the skill listing went over budget" / "— around plugin update to 6.2.0" | quiet onset vs listing-crossing date (snapshots) and plugin `lastUpdated` | One annotation line on flagged rows + tick marks on the drawer trend strip | S1 (budget), S2 (update boundary) |
| Is this silence new for THIS skill? | Current quiet streak vs longest previous gap | sorted inter-fire deltas | Drawer: "Quiet 34d — longest previous gap was 12d" | S2 |
| Staple or one-burst? | Distinct active weeks / weeks since first fire; "all fires within 7 days" flag | ledger ts | Drawer dot-strip + "tried & dropped" badge in table only for one-burst | S2 |
| How much of my work does it touch? | Sessions with ≥1 fire / total sessions | ledger sessionIds vs transcript session count | Drawer: "fired in 11 of 87 sessions (13%)" | S1 |

### Does the model find it? (dispatch)

| Question | Fact shown | Source | Display | Stage |
|---|---|---|---|---|
| Do I always have to type it? | auto vs typed split | Skill tool_use = auto; `<command-name>`/UserPromptExpansion = typed | Drawer split bar; table badge only at 100% typed: "never auto-fired" | S1 |
| Is it my automation, not me? | interactive vs automated share | `entrypoint` field (`cli` vs `sdk-cli`) | Drawer: "41 fires, 38 from non-interactive sessions" | S2 |
| Main agent or subagents? | main vs sidechain fires | `isSidechain` / `subagents/` path | Drawer chip next to channel split | S2 |
| Which model picks it? | per-model fire counts | `message.model` (skip `<synthetic>`) | Drawer per-model list | S2 |
| Is a twin stealing its fires? | confusable-pair fires: "identical descriptions: A fired 14, B fired 0" | existing confusable detection × ledger counts | Dispatch-confusion panel gains per-member counts + co-fired sessions | S2 |
| Does an exact-name collision corrupt the count? | collision warning: "fires cannot be split between copies" | inventory exact-name match across scopes | Warning on both rows | S1 |
| Did they type a name that doesn't exist? | external near-miss list ("invoked as `/impaccable` 2×") | external-fires set fuzzy-matched to inventory | Under the likely-intended skill in drawer | S2 |

### What does it cost me? (economics)

| Question | Fact shown | Source | Display | Stage |
|---|---|---|---|---|
| Cost per use? | (ambient chars × sessions + body × fires) / fires; zero-fire renders "paid N, never fired" | inventory chars × ledger counts | Sortable `tok/fire` column | S1 |
| What am I paying for nothing? | Dead-weight rent: Σ injected × sessions over never-fired items | existing neverFired × session count | Header readout, click filters table | S1 |
| Too new to judge? | age gate on the dead-weight amber: "installed 3d ago" | provenance date | Amber only when the install date predates the window start (present for the whole observed window, still silent) — an empirical rule, no magic threshold; younger items show the install fact instead | S1 |
| What would disabling save? | savings-if-disabled = injected × sessions/window | same | Row affordance + live what-if total while toggling | S2 |
| Which descriptions to shorten? | Modeled listing cut line (documented drop order: fewest fires first) + per-dropped-item headroom needed | listing chars cumsum in ledger fire order vs 8,000 | Budget bar with hatched dropped segments + divider row in table | S2 |
| Wasted loads? | interrupted fires × body tokens; mis-trigger rate | existing interrupt attribution | Badge only when present: "3 interrupted (~9k tok, 21% of fires)" | S1 |

### Is it healthy? (content + reliability)

| Question | Fact shown | Source | Display | Stage |
|---|---|---|---|---|
| Does it ever fail to launch? | fires split ok / error / rejected, last error verbatim | `toolUseResult.success`, `is_error`, rejection string | Drawer: "41 fires (3 errored, 1 rejected) — last: `<error>`"; hollow marks on trend strip | S1 |
| Did my edit fix it? | "edited 5d ago — 2 fires since" + edit tick on trend strip | max mtime across skill dir vs fire ts; git edit count where tracked | Drawer freshness line + trend marker | S2 |
| Load-bearing and untouched? | "unchanged 187d · 41 fires in that span" | same inputs, opposite direction | Same drawer line | S2 |
| Do its bundled files get used? | per-file "read in 4 of 12 fires" | Read tool_use paths under the skill dir in the same transcripts | Drawer file list | S3 |
| Do its references resolve? | "2 referenced paths missing: scripts/validate.py …"; script exec-bit check | static path extraction from SKILL.md + `existsSync`/mode | Drawer facts with SKILL.md line numbers | S2 |
| Is the plugin update relevant? | "1.4.0 available since 47d — update changes this skill's files / identical in 1.4.0" | marketplace git date; byte-compare across cached version dirs | Drawer line under version info | S3 |
| Fires across the update boundary? | "since update (12d): 0 fires · prior 12d: 9" (symmetric windows) | `lastUpdated` boundary over ledger ts | Drawer line + sparkline tick | S2 |
| Old versions still on disk? | "2 superseded versions on disk (5.1.0, 6.1.1 · 3.8 MB)" — paths printed, never deleted | cache walk minus active versions | Plugin group row line | S3 |

### Where did it come from, where does it run? (provenance + place)

| Question | Fact shown | Source | Display | Stage |
|---|---|---|---|---|
| When installed, from where? | "installed 136d ago from claude-plugins-official @ 61c0597 · updated Mar 22" / "hand-written, created Apr 6" | provenance chains above | Drawer provenance line; age sortable via fires cell for never-fired | S1 |
| How long install → first fire? | "installed → first fire: 9d" (only when install date is inside observable history) | provenance vs ledger first ts | Drawer | S2 |
| Which projects? | named project list with per-project counts | `project` field group-by | Drawer chips under breadth count | S1 |
| Wrong scope? | "scope: user · every fire in context-audit" (also: same name at both scopes) | scope × project histogram | Row chip + faceted filter | S2 |
| Which providers read it, who actually uses it? | `readBy` list + per-provider fires/last-fired matrix with per-provider window dates | rollout AGENTS.md loads, ledger provider group-by | Drawer for single items; provider overlap matrix view for all shared assets | S1 (readBy + per-provider fires), S2 (matrix view) |
| Duplicated across providers? | "also exists as a Codex skill (identical body)" | name match + body hash across providers | Cross-link on both rows | S2 |

### Can I verify any of this? (drill-down — the creed made literal)

| Question | Fact shown | Source | Display | Stage |
|---|---|---|---|---|
| Show me the actual fires | Reverse-chron event list: date · project · channel chip · outcome · interrupted marker | ledger filtered by (provider, kind, name); `src.file`+`line` per event | Drawer "invocations" section, capped 50 + "show all N"; each row opens the transcript at the line via the existing open affordance; rows whose transcript was purged say "transcript deleted (event retained)" | S1 |

Note: `src/history.ts` already builds `{file, lineNo, timestamp}` per invocation and discards them in `toUsage()` — the ledger simply stops discarding.

### The whole inventory (portfolio)

| Question | Fact shown | Source | Display | Stage |
|---|---|---|---|---|
| Does the system earn its rent? | "31 of 99 sessions used any skill" · "3 skills account for 84% of fires" · top-5 by window spend | single ledger pass | Rollup strip above the table, each stat links to its pre-filtered proof view | S2 |
| Which flags matter first? | flagged items ordered by fires/last-fired/projects (fired partition first) | findings × ledger join | "Security × activity" card; table security badge gains "· 14 fires" | S2 |
| Where's the prune quadrant? | 2×2 cost × fires scatter, real units, median line annotated, quadrant counts + summed chars | two existing columns | Quadrant view, click filters table | S2 |
| Is the pack worth it? | "superpowers · 13 skills · 4,180 tok/session · 2 of 13 fired · last 07-28" | group-by plugin | Collapsible plugin header rows (existing group rows, enriched) | S2 |
| What changed since last scan? | "+2 skills, +1,204 tok/session, 1 plugin updated" | snapshots.jsonl diff | Header delta chip | S2 |
| Is the pile outgrowing use? | owned step-line vs distinct-fired-per-week bars, each line's source captioned | snapshots + provenance backfill vs ledger | Small two-line chart | S3 |
| Was disabling safe? | "disabled 12d ago — 0 attempted invocations since · referenced by 2 other skills" | external-fires after disable mtime; static name references in other bodies | Drawer line + referenced-by warning at disable time | S3 |

### Explicitly not shipped (honest limits)

- **Post-fire correction rate** ("did the user reject the output") — needs LLM judgment of transcript content. Out of the default scan permanently; if ever built, opt-in, batched, and labeled as model-judged.
- **Trigger recall** ("should have fired but didn't") — no deterministic version exists. One measurable sliver may ship later: sessions where the user typed the slash command while the description was verifiably dropped from the over-budget listing.
- **Per-skill-run token cost** — `message.usage` is on 100% of assistant lines (verified), but attribution over a skill-run window is confounded (cost hides in cache fields, subagent work lives in separate files, interleaved non-skill work over-credits). Per-**agent** run cost is near-exact (sum the agent's dedicated `subagents/agent-<id>.jsonl`) and may ship for agent rows in S2, labeled with its method. Per-skill stays out until it can be stated honestly.

  **The agent carve-out was taken in S2.** `agentCost` sums *total tokens processed* — input + output + cache creation + cache read — deduped by `message.id`, because one assistant response spans several transcript lines repeating the same usage object and per-line summing would multiply a run's cost by its block count. That method string renders inline wherever the figure does, including that it is a token count and **not a bill** (cached input is priced far below fresh input). Runs whose transcript the 30-day purge already took are *absent*, never zero, so the figure states its denominator ("priced n of m launches"). Per-skill cost remains out, permanently.
- **Any score, grade, or composite index.**

### Limits found while building S2/S3 (stated, not worked around)

Each of these is a claim the design assumed was available and the evidence would not support. In every case the tool says nothing rather than saying something plausible.

- **"1.4.0 available since 47d" does not ship.** Nothing local dates a version's publication: the official marketplace checkout is a GCS sync with no git history, overwritten wholesale on refresh, and every candidate timestamp (`known_marketplaces.json` `lastUpdated`, the catalog cache's `fetchedAt`) reads as *today* after any sync — which would report a months-old release as "available since today". The other half of that row — whether the newer cached version actually changes *this* skill's files — ships as a real byte comparison. The date needs the network, so it is absent.
- **`updateRelevance` absent means unknown, never "unchanged".** It compares against versions already in the cache; if the newer version was never downloaded there is nothing to compare and the row says nothing.
- **The plugin update *from*-version is unrecoverable.** Snapshots record no versions and the cache cannot prove which superseded directory was live. `delta.pluginsUpdated[].from` is therefore optional and the UI says "previous version not recorded" rather than printing a sentinel that reads like a version.
- **Agent launches made from inside a sidechain are not linked to their run's cost.** `LedgerEvent.agent` already means "the sidechain this fire happened in" for every other kind, and overwriting it on those events would change the field's meaning for every consumer. Main-thread launches link exactly; the rest are absent, which the "priced n of m launches" denominator states.
- **Bundled-file reads are a floor, not a total.** Only the `Read` tool counts: a file opened via `cat`, surfaced by Grep, or @-mentioned is invisible to the transcript pass.
- **A missing reference cannot always be distinguished from an example path.** `resolveRefs` was narrowed to directory-shaped assets only (a single-file agent ships no bundled files, so every path in its body is prose — this alone cut reported paths from 124 to 21 on the reference machine) and rejects placeholder shapes, but a plan template's `src/recovery.js` and a skill's genuinely missing `reference/typography.md` are indistinguishable to any static reader. So the row renders as a fact carrying its method, with no severity colour and no table badge — it is something to check, not a defect to alarm about.
- **Disable dates are an upper bound.** There is no disable log; moving a skill into `skills-disabled/` is a rename, which leaves mtime alone but bumps ctime — as does anything else touching the directory's metadata. The figure carries `disabledAtSource: "ctime"` so the UI can label the bound. Plugins disabled through `settings.json` get no date at all, because that file's mtime dates the last edit to *any* setting on the machine.
- **Dead-weight rent is a per-session figure.** The design wrote it as "Σ injected × sessions"; the implementation sums `injectedChars` over age-gated silent items and the header renders it as "tok/session", which is what it is. It must never sit unlabeled beside `portfolio.topSpend`, which *is* a window total.

## Dashboard changes (summary)

- **Table:** `fires` cell gains lifetime · window + trend glyph; never-fired cells show age inline ("never · installed 62d"); new sortable `tok/fire` column; security badge gains fire count. Column bloat is controlled by the existing `activeCols()` uniformity collapsing — no column picker.
- **Header:** dead-weight rent quantifies the existing never-fired readout; S2 adds the portfolio rollup strip and since-last-scan delta chip.
- **Drawer:** grows engraved sections — provenance · fires (channel/agent/model/provider splits) · invocations drill-down · trend strip with event ticks (edits, updates, budget crossing) · content health · reliability · relationships (co-invocation, collisions, cross-provider twins).
- **New views (S2):** quadrant scatter, budget bar with cut line, provider overlap matrix — all under `.impeccable.md` rules: data-bearing marks only, one amber signal, tabular numerics, no decorative sparklines; the weekly dot-strip and event ticks are data-bearing and drawer-scoped.

  **As shipped:** the four views (those three plus S3's growth chart) live behind a single-select `panel` bank above the results — deliberately not called "view", which the rail already uses for the lens filter. Each panel has a teaching empty state and none draws an empty axis as though it were a measurement of zero. Three details are load-bearing rather than decorative:
  - The **prune quadrant** states what it did NOT plot and why ("1 not plotted — no dispatch record exists for them, which is not a zero · 4 not plotted — disabled, so no cost is being paid"). Plotting an absent measurement at x=0 would render absence as zero, which is the exact error the whole catalog is built to avoid.
  - The **overlap matrix** puts each provider's OWN window in its column head, because the stores keep wildly different amounts of history — on the reference shape, claude 43 days against codex 5 months against cursor 15 months — and one shared caption would make the counts look like-for-like when they are not. An empty cell renders as "no record", never 0.
  - The **growth chart** breaks its owned line across weeks with no snapshot rather than interpolating. Joining them would draw a history the snapshots never recorded.

  The budget panel's cut line is a MODEL of the documented drop order, standing in for invocation counters Claude Code keeps to itself, and says so wherever it appears.
- **Epistemic house rules extended:** every count states its window or trackedSince date; `n/a` ≠ `0` ≠ "0 since backfill horizon"; backfilled and labeled-approximate values always name their method inline.

## Architecture notes

- New module `src/ledger.ts` (event types, append/dedupe/read API) beside `src/history.ts`; adapters' `usage()` returns raw events; `buildUiPayload` merges ledger + live-window facts at the existing `usageByName` join, now keyed `(provider, kind, name)`.
- `UiFires` grows: `lifetime`, `trackedSince`, `byChannel`, `byAgent`, `byModel`, `byProvider`, `outcomes`, `weeklyBins`, `events` (drill-down page). `UiItem` gains `provenance`, `readBy`, `collision`.
- CLI: `context-audit hooks install|uninstall`, `context-audit log-event` (hook target), `context-audit backfill`; `--json` output gains the lifetime block (diffable, as ever).
- Ledger writes are atomic appends; `log-event` validates stdin against the event schema and exits 0 silently on malformed input (a broken hook must never break the user's session).

## Testing

- Fixture transcripts (main + `subagents/`), rollouts, history.jsonl, and installed_plugins.json → ledger fixtures. Ingestion is deterministic: run-twice idempotency and hook+scan dedupe are exact-equality tests.
- Backfill cleaning rules get the observed pathological fixtures: the `/usage` poller session, glued `/status/exit`, pasted absolute paths, typo'd names.
- Provenance chains tested per asset class with a fake home dir (the `SourceContext.home` injection already exists for this).
- Hook payload parsing from documented stdin shapes; `log-event` fuzzed with malformed input (must exit 0).
- UI additions stay inside the DOM-free `render.ts` contract; the Node smoke test covers them.

## Out of scope

Telemetry of any kind; daemons/watchers; auto-installed hooks; in-browser ledger editing; cross-machine sync; LLM-judged metrics in the default scan; Cursor ingestion (S3, schema-ready); invented usage for providers with no readable history.
