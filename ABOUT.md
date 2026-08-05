# context-audit

The dashboard for your skills: what they cost in every session, what actually fires, what's dead weight, and what's dangerous — for Claude Code, Codex, Cursor, and the cross-tool AGENTS.md standard.

## What it is

A zero-dependency tool with three surfaces over one deterministic engine:

- **A companion skill** (`npx context-audit install-skill`) — the surface most people actually meet, because they ask their agent rather than run a scanner. It dispatches on the symptoms ("why isn't my skill firing?", "what is my context costing?"), runs the audit, verifies findings before alarming anyone, and opens the dashboard when browsing beats chat.
- **A local dashboard** (`npx context-audit ui`) — a skills-first inventory: per-item token cost, fires in the transcript window, dead-weight highlighting, security findings, one-click enable/disable for Claude user skills. Localhost only, token-gated.
- **A CLI** — the same audit as exit codes and JSON: deterministic, diffable over time, CI-able.

It never scores or judges. Every line of output is a fact you can verify in ten seconds by opening the file it points at, across three lenses:

- **Cost** — the tokens injected into *every* session (names + descriptions, instruction-file bodies) versus the tokens loaded only on invoke, and how close the skill listing sits to Claude Code's ~8,000-character budget — past which descriptions are silently dropped and skills stop auto-triggering.
- **Usage** — from your own local transcript history: which assets actually fire, which never have in the window, and which get interrupted right after firing. Nothing leaves your machine.
- **Security** — patterns drawn from real, documented skill-malware campaigns: download-execute in all its spellings, reverse shells, credential-paths-next-to-egress, invisible-unicode smuggling (decoded for you), malicious frontmatter hooks, plugin-manifest promotion. Findings carry **severity** and **confidence** as separate axes.

## What it does, mechanically

1. **Discovers** every instruction asset per source — Claude skills/agents/commands/CLAUDE.md, Codex prompts and AGENTS.md, Cursor rules — reading *all* files in each (bundled scripts and reference files are things your agent can read and run).
2. **Normalizes** each file (NFKC, invisible-character stripping, homoglyph folding) before pattern-matching, so keyword-splitting evasions don't slip through.
3. **Runs three analyzers** — content (arithmetic and string comparison), security (mechanism-modeled pattern and structural checks plus whole-package checks), and usage (streams local JSONL transcripts and Codex rollouts, attributing invocations and post-invocation interrupts).
4. **Reports** — as the dashboard, as a human-readable report, as `--agent` compact JSON (~1.8k tokens instead of ~22k on a 75-skill directory), or as full `--json` — and **exits 1 if anything is flagged**, so it can gate CI.

## Why it was built

Two reasons, both concrete.

**A real, personal friction.** Across a 75-skill directory, dispatch kept misfiring — identical descriptions competing for one trigger, skills paying token rent every session and never firing, and a skill listing far enough over Claude Code's character budget that descriptions were being silently dropped, which looks exactly like the model ignoring you. skillet (the sibling project) fixes *over-specified skill bodies*; it deliberately doesn't touch collisions, dead weight, cost, or security. context-audit is the report that skillet acts on.

**A real, timely threat.** Through 2026, skill marketplaces were hit by malware campaigns — credential stealers in `## Prerequisites` sections, payloads smuggled in invisible unicode. A skill-based scanner can't safely do this job: asking a model to read a malicious skill in-session hands the attacker the microphone. A deterministic CLI that runs *before* anything reaches the agent's context can. That's why the engine is a CLI, not a skill — the companion skill only *drives* it and reads its verdicts.

## The honest boundary

context-audit catches the **commodity** threat — the unobfuscated `curl | bash`-and-base64 attacks actually seen in the wild — and, after an adversarial pass, the cheap re-spellings of those attacks: a different interpreter at the end of the pipe, a decode hop, a two-step download, a YAML restatement of a hook declaration, a payload staged in a directory the walker used to skip.

It is **structurally defeated by the adaptive threat**. Encrypted self-extracting payloads staged for runtime evade ~96% of *every* static scanner. There is no regex for "this plain English is malicious," and exfiltration routed through the agent's own sanctioned tools (Read, then WebFetch) presents no shell and no URL literal to match. Those cases are pinned in the test suite as fixtures that must stay *unflagged*, so the boundary is enforced rather than merely described. Code inside genuine third-party dependencies is counted, not read — that is `npm audit`'s job.

The lesson from the adversarial pass, which the detectors are organized around: **enumerating spellings loses, modelling mechanisms holds.** Every check that listed the ways to write an attack was defeated by writing it differently; every check that described what the attack has to accomplish survived. A clean scan is a passed triage, not a guarantee — the same claim `npm audit` makes. Runtime sandboxing is the complement; this is the fast, free, offline first pass.

**Design principle, held throughout:** the tool measures, the model judges. Determinism below the model, autonomy above it.
