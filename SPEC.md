# context-audit — spec

The dashboard for your skills, and the deterministic engine under it. Audits the instruction files AI coding tools execute — Claude Code skills/agents/commands/CLAUDE.md, Codex prompts and AGENTS.md, Cursor rules — and reports **facts, never judgment**: what each asset costs per session, what actually fired in the local transcript window, and whether anything looks dangerous. The subjective step — merge, rewrite, delete, uninstall — belongs to the model (skillet) or the human, with this tool's evidence in hand.

## The one design rule

Every line of output must be a fact the user can verify in ten seconds. Any check that needs an indefensible threshold either becomes empirical or gets cut. No scores, no grades, no "quality."

## Surfaces, in the order users meet them

1. **The companion skill** (`skill/SKILL.md`, installed by `context-audit install-skill`). Most users ask their agent, not a terminal. The skill dispatches on the symptoms people feel ("my skill isn't firing", "context feels bloated"), runs `--agent`, verifies findings against cited lines before alarming, and hands over the dashboard when browsing beats chat.
2. **The dashboard** (`context-audit ui`). Skills-first inventory on a localhost server: per-item token cost with meters, fires in the usage window, dead-weight highlighting, security findings, enable/disable for Claude user skills, plugin updates via the official CLI. Binds to 127.0.0.1, token-gated on every request, Host/Origin validated.
3. **The CLI**. Deterministic and scriptable: exit codes, `--json`, `--agent`, diffable over time. `scan <path>` is the pre-install gate — it runs strict (capability grants fail it) and lets an agent decide before untrusted content enters its context.

## Three evidence classes

**Content facts** (deterministic, from the files): missing/empty/duplicate descriptions; frontmatter name ≠ directory name; per-asset and total body token estimates (chars/4, labeled as estimates); the always-injected cost (names + descriptions, or whole bodies for instruction files) vs on-invoke cost; the Claude Code skill-listing character budget and the percentage of it in use.

**Security facts** (deterministic, from the files — a CLI rather than a skill because a skill-based scanner feeds the malicious content to the model it is trying to protect): the detection engine in `src/security.ts` and `src/frontmatter.ts`, built from documented campaign shapes and organized around mechanisms rather than spellings. Findings carry severity and confidence as separate axes, plus an absolute `path` and `line` to verify. Exit 1 on any flag.

**History facts** (empirical, from local transcripts): per-asset invocation count, session count, last-fired date; never-fired assets; post-invocation interrupts. Claude transcripts and Codex rollouts are read; Cursor keeps no readable history and the report says so instead of guessing. The scan window is stated everywhere it matters — it starts at the oldest surviving transcript, so "none in window" is never "never". Nothing leaves the machine.

## Sources

| id | discovers | always-injected model | usage history |
|---|---|---|---|
| `claude` | `~/.claude` + `./.claude` skills, agents, commands; global + project `CLAUDE.md`; plugin assets at their active version | names + descriptions; instruction-file bodies | `~/.claude/projects` |
| `codex` | `~/.codex/AGENTS.md`, `~/.codex/prompts/*.md` | AGENTS.md body; prompt names | `~/.codex/sessions` |
| `cursor` | `./.cursor/rules/*.mdc` (nested included), legacy `./.cursorrules` | `alwaysApply` + legacy bodies; rule descriptions | none kept |
| `agents-md` | `./AGENTS.md`, `~/AGENTS.md` — audited once, not per consuming tool | whole body | — |

The unit of audit is "an instruction file an agent will execute," not "a Claude skill." The engine is shared; each source contributes discovery, a cost model, and (where transcripts exist) usage.

## Non-goals

Fix application (that's skillet's job), in-browser editing/installing/deleting, sandboxed runtime detonation, marketplace browsing or installing (updating an *already-installed* plugin does ship — it shells out to the official `claude` CLI and reads the local marketplace checkout for the version claim), remote URL/tarball scanning, scores of any kind. A routing-collision simulator and SARIF output are the likeliest next additions.

## Constraints

Zero runtime dependencies (a security-adjacent tool should be auditable in one sitting). Node 18+. TypeScript, `tsc` build plus an esbuild bundling step for the dashboard page, single `bin`. The regression corpus in `test/run.mjs` pins every fixed evasion and a false-positive floor that must stay clean.
