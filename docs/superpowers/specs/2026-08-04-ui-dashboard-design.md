# context-audit ui — local skills dashboard

**Date:** 2026-08-04
**Status:** Approved design, pre-implementation

## What and why

A `context-audit ui` subcommand that renders the audit as a local web dashboard and adds safe management actions. The problem it solves: instruction files (skills, agents, commands, prompts, rules) are invisible — buried in dotfile directories, silently costing tokens every session, with no way to see what's there, what never fires, or what's flagged. The CLI already gathers all of these facts; the dashboard makes them visible and actionable.

Positioning: the dashboard is the visual face of the existing tool, not a new product. One package, one repo, one launch story: "know what your skills are doing" — cost, usage, and security as three lenses over one inventory.

## Decisions locked during brainstorming

1. **GUI layer on context-audit**, not a standalone manager. The CLI stays the headline; `ui` is its killer feature.
2. **View + safe toggles** in v1. No in-browser editing, no installs, no deletes.
3. **Claude-first for actions and history; multi-provider for inventory.** The existing `sources/` adapters (claude, codex, cursor, agentsmd) feed the inventory view from day one. Usage history remains Claude-only (only Claude Code keeps readable local transcripts) and the UI labels this honestly.
4. **Ships as `context-audit ui`** — same package, zero runtime dependencies preserved.
5. **Approach A:** one-shot audit snapshot + tiny action server. No file watchers, no websockets. Rescan is a button.

## UI content

One page, one inventory, three lenses.

- **Header strip (the pitch in four numbers):** total instruction files across providers; total always-injected tokens per session; count of never-fired items; count of security flags.
- **Main table:** one row per inventory item. Columns: name, provider, type (skill / agent / command / prompt / rule), token cost, fire count + last fired (Claude rows; others show "n/a — no local history"), security-findings badge, enabled/disabled state. Sortable columns; filter chips for provider, type, "never fired," "flagged."
- **Detail drawer** (click a row): full description, file path, frontmatter, each security finding with its evidence line, action buttons.
- **Per-row actions:** enable/disable toggle and open-in-editor. Toggles appear only where a safe convention exists: Claude user skills, via the `~/.claude/skills` ↔ `~/.claude/skills-disabled` move convention. Plugin-cache skills, project-scoped items, Codex prompts, and Cursor rules are read-only in v1, with a tooltip explaining why (no invented disable conventions for other vendors).
- Items the engine could not fully parse render with a "couldn't parse" badge rather than being dropped.

## Architecture

- `context-audit ui [dir]` runs the existing audit pipeline (sources → content → history → security), holds the result in memory as one JSON payload shaped by the existing `types.ts` model, starts a `node:http` server bound to **127.0.0.1 only**, and opens the browser at the served URL.
- **Frontend:** plain TypeScript in `src/ui/`, compiled by esbuild (devDependency) into a single self-contained HTML file shipped in `dist/`. No framework, no runtime dependencies — the published package stays hand-readable.
- **Endpoints:**
  - `GET /api/audit` — the current payload.
  - `POST /api/rescan` — re-run the audit, return fresh payload.
  - `POST /api/toggle` — body carries an item ID; the server resolves the ID to a path from its own inventory. Client-supplied paths are never accepted.
  - `POST /api/open` — open the item's file via `$EDITOR` (fallback: VS Code / `open`), launched with `spawn` and an argument array. No shell string interpolation; path comes from the server-side inventory only.
- **Data flow is one-way:** disk → audit engine → JSON → browser. The browser sends only item IDs and the session token.

## Server security

A localhost server with mutating endpoints is a CSRF/DNS-rebinding target: a malicious webpage can POST to `127.0.0.1` blind. For a security-branded tool this must be closed from v1:

- Random session token generated at startup, embedded in the URL the browser is opened at; every mutating request must present it.
- `Origin`/`Host` header validation on every request.
- Bind to `127.0.0.1` (never `0.0.0.0`).
- Requests failing any check get a 403 and are logged to the terminal.

## Actions: semantics and edge cases

**Toggle** = directory move between `~/.claude/skills/<name>` and `~/.claude/skills-disabled/<name>`.

- Refuse if the target name already exists in the destination — surface the conflict, never overwrite.
- Refuse for plugin-cache and project-scoped items (v1).
- Git-tracked skills dirs: a plain move is fine; git sees a rename and the user commits when they choose. The tool does not touch git.
- Every successful action triggers a rescan so the UI never shows stale state.
- Failures return readable error messages rendered in the drawer — no silent no-ops.

## Testing

Extends the existing `test/run.mjs` harness:

- **Toggle module unit tests** against fixture directories: move, name conflict, permission denied, plugin-refusal.
- **HTTP tests:** boot the server on a random port; exercise all four endpoints; assert 403 on missing/wrong token and bad Origin.
- **Frontend smoke test:** render the page against a fixture payload; assert header numbers and row count.
- **Existing security regression corpus stays green untouched.**
- No browser-automation rig in v1.

## Out of scope (v1)

- In-browser editing, deleting, or installing skills.
- Disable conventions for Codex/Cursor items.
- One-click skillet reduction (future family integration).
- File watching / live updates (add behind the same API later if demanded).
- Static HTML export (`--html`) — a near-free follow-up: same frontend, embed the JSON, hide action buttons.

## Success criteria

- `npx context-audit ui` opens a dashboard showing the full multi-provider inventory with correct header numbers on a real machine.
- A Claude user skill can be disabled and re-enabled from the browser, and the change is visible in `~/.claude/` and in a fresh CLI run.
- All existing tests plus the new suites pass; published package still has zero runtime dependencies.
