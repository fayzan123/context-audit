# context-audit — spec

npm audit for agent skills. Scans a skills directory (Claude Code, Codex, OpenClaw layout: `<dir>/<name>/SKILL.md`) and reports **facts, never judgment**. The subjective step — merge, rewrite, delete — belongs to the model (skillet) or the human, with this tool's evidence in hand.

## The one design rule

Every line of output must be a fact the user can verify in ten seconds. Any check that needs an indefensible threshold either becomes empirical or gets cut. No scores, no grades, no "quality."

## Three evidence classes (v0 ships all three)

**Content facts** (deterministic, from the files): missing/empty descriptions; exact-duplicate descriptions; frontmatter name ≠ directory name; per-skill and total body token estimates (chars/4, labeled as estimates); the always-injected cost (names + descriptions) vs on-invoke cost (bodies).

**Security facts** (deterministic, from the files — this is why it's a CLI, not a skill: a skill-based scanner feeds the malicious content to the model it's trying to protect): base64 blobs that decode to URLs/commands; external URLs and their domains; `curl|sh`, `eval`, `rm -rf` in bundled scripts; zero-width/bidi unicode (hidden-instruction vector); known injection phrases ("ignore previous instructions", "do not tell the user", credential-file references); path traversal out of the skill dir. Findings carry the evidence (file, line, decoded snippet). Exit code 1 when any security finding exists — CI-able.

**History facts** (empirical, from local transcripts in `~/.claude/projects/**/*.jsonl`): per-skill invocation count, session count, last-fired date; never-fired skills; invocations followed by a user interrupt. The scan window is reported so the facts are scoped. Nothing leaves the machine.

## CLI

```
context-audit [dir]              # audit a skills directory (default ~/.claude/skills)
context-audit scan <path>        # pre-install: content+security only, on any skill dir/file
  --json                       # machine output
  --no-history                 # skip transcript scan
  --transcripts <dir>          # override ~/.claude/projects
```

## Non-goals (earned by observed friction, never designed in advance)

Routing/dispatch simulator (v0.3 candidate), remote URL/tarball scanning, marketplace integration, fix application (that's skillet), scores of any kind, a GUI.

## Constraints

Zero runtime dependencies (a security tool should be auditable in one sitting). Node 18+. TypeScript, `tsc` build, single `bin`.
