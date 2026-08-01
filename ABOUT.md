# context-audit

`npm audit`, but for agent skills.

## What it is

A zero-dependency CLI that scans a skills directory — Claude Code, Codex, or OpenClaw, anything using the `<name>/SKILL.md` layout — and reports **facts about what your skills are, do, and cost.** It never scores or judges a skill. Every line of output is something you can verify in ten seconds by opening the file it points at.

It reports across three lenses:

- **Security** — patterns drawn from real, documented skill-malware campaigns: `curl | bash` and base64 download-execute, reverse shells, password-protected archives, credential paths sitting next to network egress, known exfiltration endpoints, raw-IP URLs, invisible-unicode smuggling (decoded for you), `` !`cmd` `` dynamic-context execution, malicious frontmatter hooks, and `.claude-plugin/plugin.json` promotion that silently unlocks session-start hooks, MCP servers, and background monitors. Findings carry **severity** (how bad if real) and **confidence** (how likely it's real) as separate axes.
- **Content** — empty descriptions, identical descriptions (dispatch collisions), frontmatter names that don't match their directory, and what your skills cost: the tokens injected into *every* session versus the tokens loaded only on invoke.
- **Usage** — from your own local transcript history: which skills actually fire, which never have, and which get interrupted right after firing. Nothing leaves your machine.

## What it does, mechanically

1. **Discovers** every skill in the directory, reading *all* files in each (not just SKILL.md — bundled scripts and reference files are things your agent can read and run).
2. **Normalizes** each file (NFKC + strips zero-width characters) before pattern-matching, so keyword-splitting evasions like `cu​rl` don't slip through.
3. **Runs three analyzers** — content (arithmetic and string comparison), security (~25 pattern and structural checks plus whole-package checks like credential-read-in-one-file/network-send-in-another), and usage (streams the local JSONL transcripts, attributing skill invocations and post-invocation interrupts).
4. **Reports** in one of three formats and **exits 1 if anything is flagged**, so it can gate CI.

## How it's used

```bash
# Ask your agent: "audit my skills" — the companion skill in skill/ runs this for you.
# Or directly:
npx context-audit                    # audit ~/.claude/skills, human-readable
npx context-audit path/to/skills     # any skills directory
npx context-audit scan ./downloaded  # BEFORE installing an untrusted skill
npx context-audit --agent            # compact JSON for an AI agent (~1.8k tokens vs ~22k)
npx context-audit --json             # everything, machine-readable
```

The intended flow is **agent-first**: most people won't run a scanner by hand, so a companion skill teaches the agent to run the audit, verify each flag against the cited line before alarming you, propose cleanups (paired with [skillet](https://github.com/fayzan123/skillet), which does the rewriting), and — for untrusted skills — `scan` and check the exit code **before reading the skill's content**, so a malicious skill's instructions never enter the agent's context.

## Why it was built

Two reasons, both concrete.

**A real, personal friction.** Across a 75-skill directory, dispatch kept misfiring — two skills with word-for-word identical descriptions competing for the same trigger, a frontend skill firing on general-purpose requests, skills paying token rent every session and never firing. skillet (the sibling project) fixes *over-specified skill bodies*; it deliberately doesn't touch collisions, dead skills, or security. context-audit is the report that skillet acts on.

**A real, timely threat.** Through 2026, skill marketplaces were hit by malware campaigns — prompt injection in a large share of published skills, credential stealers hidden in `## Prerequisites` sections, payloads smuggled in invisible unicode. A skill-based scanner can't safely do this job: asking a model to read a malicious skill in-session hands the attacker the microphone. A deterministic CLI that runs *before* anything reaches the agent's context can. That's why it's a CLI, not a skill.

## The honest boundary

context-audit catches the **commodity** threat — the unobfuscated `curl | bash`-and-base64 attacks that were actually in the wild, which it would have caught nearly all of — and, after an adversarial pass, the cheap re-spellings of those same attacks: a different interpreter at the end of the pipe, a decode hop, a two-step download, a YAML restatement of a hook declaration, a payload staged in a directory the walker used to skip.

It is **structurally defeated by the adaptive threat**. Encrypted self-extracting payloads staged for runtime evade ~96% of *every* static scanner. There is no regex for "this plain English is malicious," and exfiltration routed through the agent's own sanctioned tools (Read, then WebFetch) presents no shell and no URL literal to match. Those two cases are pinned in the test suite as fixtures that must stay *unflagged*, so the boundary is enforced rather than merely described. Code inside genuine third-party dependencies is counted, not read — that is `npm audit`'s job.

The lesson from the adversarial pass, which is what the detectors are now organized around: **enumerating spellings loses, modelling mechanisms holds.** Every check that listed the ways to write an attack was defeated by writing it a different way; every check that described what the attack has to accomplish survived. A clean scan is a passed triage, not a guarantee — the same claim `npm audit` makes. Runtime sandboxing is the complement; this is the fast, free, offline first pass.

**Design principle, held throughout:** the tool measures, the model judges. Determinism below the model, autonomy above it.
