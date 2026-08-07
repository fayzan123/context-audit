# Agent fires, and why nothing fired — a measurement fix and the diagnosis it unblocks

**Date:** 2026-08-07
**Status:** Approved design, pre-implementation
**Relates to:** `2026-08-05-skill-usage-ledger-design.md` (the ledger's name rule is amended here), `2026-08-06-dashboard-ui-overhaul-design.md` (the activity cell gains a cause; the say-it-once and deviation-mark rules are unchanged and binding).

Two pieces of work in one spec because they are one piece of work. Part A fixes a detector that cannot observe 62% of the inventory. Part B explains the resulting "never fired" number — and cannot be built first, because before Part A the honest explanation for most of that number is *"we cannot see it"*, which is a fourth cause Part B has to display and Part A has to eliminate.

## Part A — every agent fire is discarded

### The defect

`src/ledger.ts:18` defines the name gate both fire-writers share:

```ts
export const NAME_RE = /^[A-Za-z0-9:_-]+$/;
```

No space. Claude Code registers a subagent by its frontmatter `name:`, which is human-readable prose — `LinkedIn Content Creator`, `Backend Architect`. `src/history.ts:345` applies this regex to every dispatch name and `continue`s past failures, so the invocation is never built and no event is ever emitted.

### Measured on the design machine

- **110 of 110** registerable agents fail the gate. Not most — all.
- The **23 that pass are not agents**: `README`, `CONTRIBUTING`, `QUICKSTART`, `EXECUTIVE-BRIEF`, `PULL_REQUEST_TEMPLATE`, `phase-0-discovery` … every one has `fmName === undefined`. The only names the detector accepts are files Claude Code cannot register and which therefore can never fire.
- Agents carry **5,634 tok/session — 62%** of the always-injected cost.

Verified against the one live test case on the machine. `LinkedIn Content Creator` was dispatched **2026-07-21T23:43:15Z**, inside the 2026-07-04 → 2026-08-07 window. The evidence survives in two independent places: the parent transcript's `Agent` launch line carrying `subagent_type`, and a sidecar `subagents/agent-abcb4a6368353ca42.meta.json` containing `{"agentType":"LinkedIn Content Creator", …}`. `claudeAdapter.usage()` returns 15 usage rows, all skills, and **zero** events naming it.

**Installing hooks does not fix this.** `src/hooks.ts:378` and `:399` apply the same `NAME_RE`. Both writers share the gate, so real-time capture drops agent fires exactly as transcript scraping does.

### Why this is severe out of proportion to its arithmetic

Only one real agent dispatch exists in 391 transcripts, so the *count* is wrong by one. That is not the problem. The problem is that **"133 agents, never fired" is presented as a measurement and is a detector that cannot return anything else**, and the product's one rule is that every line of output is a fact the user can verify in ten seconds. The `prune` view then recommends disabling those agents and offers a bulk control to do it, on evidence that does not exist.

### The fix, and the boundary it must not break

The obvious repair — widen `NAME_RE` so agent names fit — is wrong, and the first draft of this spec proposed it. The gate guards a durable on-disk store against banking a typed command's *arguments*, which is a privacy boundary rather than a naming convention. What is actually true is narrower: the gate is applied to a channel it was never designed for.

Empirically derived from the 110 real agent names on the design machine:

- non-alphanumeric characters actually in use: `space`, `&`, `,`, `-`, `/`
- longest observed name: **60** characters
- names containing a control character: **none**

**The gate is not widened. A second, channel-scoped gate is added beside it.**

`NAME_RE` is a privacy boundary, not a naming convention, and `test/unit-ledger.mjs:451` pins it as one:

```js
check("NAME_RE refuses args-shaped strings",
      !NAME_RE.test("impeccable teach --project ~/clients/acme"));
check("args-shaped name fails the gate on dispatch channels",
      !isLedgerEvent(ev("g7", …, { name: "impeccable SECRET-ARG never store me" })));
```

A typed command carries arguments — client paths, secrets — and `hooks.ts:397` strips them to the first token *and then* checks `NAME_RE` as a backstop before anything reaches a durable on-disk file. Widening that constant would bank `~/clients/acme` into the ledger. **`NAME_RE` is therefore left exactly as it is**, and keeps governing the `skill` and `command` kinds.

What is added is a separate rule for the one kind whose name never passes through a user-typed line:

```ts
/**
 * An agent's dispatch name. Separate from NAME_RE because the two channels
 * carry different risk, not because agents deserve a laxer convention.
 *
 * A skill or command name can arrive with arguments appended to it — a typed
 * line is split and stripped before it is checked, and NAME_RE is the backstop
 * behind that stripping (unit-ledger: "impeccable teach --project ~/clients/acme"
 * must never reach the store). An agent name arrives as `subagent_type`, a
 * structured tool parameter the harness fills from a registered frontmatter
 * `name:` — there is no line to split and no argument tail to strip.
 *
 * Control characters are banned rather than discouraged: U+0000 is the
 * separator in the usage join key (inventory.ts joinKey and the byName group
 * key), so a name carrying one could forge a join onto another asset's row.
 * The 80-character cap sits 20 above the longest name observed across 110 real
 * agents, and refuses a prose blob from a malformed transcript.
 */
export const AGENT_NAME_RE = /^[^\u0000-\u001F\u007F]{1,80}$/;
```

**Residual risk, stated rather than papered over.** Because `subagent_type` is a tool parameter, a malformed or hostile caller can put an arbitrary string in it, and `AGENT_NAME_RE` will accept anything short and control-character-free — including something argument-shaped. This is materially narrower than the typed-command case (there is no user-typed line feeding it) and the stored value is inert: it is joined against the discovered inventory at read time, so an unregistered name attaches to no asset. It is **not** zero risk, and the alternative — enumerating argument spellings — is the approach `ABOUT.md` records as losing every time.

`STORE_NAME_RE` (`src/ledger.ts:37`) gains the same split at the durable boundary: `isLedgerEvent` selects the rule from the event's own `kind`, so an args-shaped name is still refused on a `skill` or `command` event while `LinkedIn Content Creator` is admitted on an `agent` one. Widening `STORE_NAME_RE` wholesale would reject nothing today and leak tomorrow.

**Both writers must continue to agree.** `history.ts` and `hooks.ts` import both constants and select by kind; neither grows its own copy.

The three call sites do not all change, and this is the one place the fix can be got exactly backwards:

| site | channel | rule |
|---|---|---|
| `history.ts:345` | `subagent_type` from a transcript | `AGENT_NAME_RE` when `kind === "agent"`, else `NAME_RE` |
| `hooks.ts:378` | `subagent_type` from a live `Agent`/`Task` hook | `AGENT_NAME_RE` when `kind === "agent"`, else `NAME_RE` |
| `hooks.ts:399` | **a typed command, already split to its first token** | **`NAME_RE`, unchanged** |

`hooks.ts:399` is the site the privacy boundary exists for — its own comment reads *"First token only, slash stripped: the dispatch name is stored, args never are"*, and `NAME_RE` is the backstop behind that stripping. Applying `AGENT_NAME_RE` there would admit `impeccable teach --project ~/clients/acme` to the ledger, which is precisely the failure this spec was rewritten to avoid.

### Compatibility

Widening what is *accepted* is backward-compatible: every event already in a ledger still validates, and no migration runs.

Agent fires that occurred before this fix were never banked and are **not** recoverable from the ledger. They **are** recoverable from any transcript still on disk, because the scan re-reads transcripts on every run and banks what it finds. So a user's agent history reappears for their surviving transcript window and no further back. This is stated, not silently repaired.

### The second defect in the same area

`~/.claude/agents` holds 133 `.md` files; 110 carry a frontmatter `name:`. The payload contains **133 agent items** — every file, including the 23 that Claude Code cannot register. Meanwhile the source emits a caveat reading:

> "23 files under ~/.claude/agents are not agent definitions: no frontmatter name, so Claude Code cannot register them and **they are not counted here**"

They are counted. `README` and `CONTRIBUTING` appear as agent rows in the inventory. The caveat's claim is the correct behaviour and the filter simply does not reach the payload.

These rows carry **0 injected chars**, so no cost figure is wrong. What is wrong is the inventory count and the never-fired count: 23 phantom rows that can never fire are inflating the number this tool exists to explain.

A file under `agents/` with no frontmatter `name` is not an agent and does not become an item. The caveat stays, and becomes true.

## Part B — every never-fired item states why

### The number today

172 of 187 items have never fired. Bucketed against the causes the payload can already establish, plus the two this spec adds:

| cause | count | share |
|---|---|---|
| unmeasurable (Part A) | 110 | 64% |
| dropped from the listing | 17 | 10% |
| disabled | 5 | 3% |
| collision | 1 | 1% |
| no cause found | 39 | 23% |

**77% of the product's loudest number has a nameable cause, and none of them are shown.** The dashboard renders all 172 identically, as `never used · Nd old`, which reads as one verdict — *you do not need this* — over five different situations, one of which is a bug and three of which are fixable without deleting anything.

After Part A, the same table reads: 23 phantoms cease to be rows, 110 become measurable, and the residual "no cause found" falls to **16 skills costing 1,085 tok**. That residual is the honest dead weight, and it is the number `prune` should have been acting on all along.

### The causes, in resolution order

First match wins. Every one is a fact with a cited source, never an inference.

1. **`unmeasurable`** — nothing on this machine can observe this asset's fires. After Part A no Claude agent is in this state, but the category is kept and is *not* dead code: Cursor keeps no per-rule history that survives every store shape, and any future provider without usage lands here. It is the only honest label for "absent", and it must never render as zero.
2. **`disabled`** — the asset is in the disabled sibling directory. It cannot fire.
3. **`dropped`** — the listing budget cut it. Already computed: `budgetCut.order[].dropped`. It still exists and can still be typed; it has stopped auto-triggering.
4. **`collision`** — its description **wholly contains** another enabled, dispatchable asset's description, and that asset has more fires.
5. **`unused`** — no cause found. The residual, and the only bucket that means what the page currently implies for all of them.

### Collision detection: containment, never similarity

The check is string containment after whitespace normalisation and case folding, on descriptions of at least 60 characters, between two enabled dispatchable assets of the same kind.

**Similarity scoring is explicitly rejected**, and this is the load-bearing decision of Part B. The one design rule says any check needing an indefensible threshold either becomes empirical or gets cut. "These descriptions are 34% similar" is a score with a made-up cutoff — exactly what this product refuses to ship. "This description contains that one in full" is a fact the reader verifies in ten seconds by looking at two lines. A sweep of all 187 items found the difference is not academic: containment yields **1** finding; a 30% Jaccard cutoff yields **4**, of which 3 are unrelated agents that merely share domain vocabulary.

The live finding on the design machine:

```
impeccable.description.startsWith(frontend-design.description) === true
```

| | fires | last fired | listing cost |
|---|---|---|---|
| `frontend-design` | 5 | 2026-08-07 | 309 chars |
| `impeccable` | 0 | never, 110d | 454 chars |

`impeccable`'s description is `frontend-design`'s verbatim plus one sentence. It pays 454 characters into a listing that is at 153% of budget and drops 17 skills.

**The label is directional but makes no causal claim.** The item labelled `collision` is the one whose description is the superset *and* which has strictly fewer fires. The evidence line states the relationship and both fire counts; it does not say one caused the other, because dispatch order is the model's, not ours. *The tool measures, the model judges* — the user is being handed the pair, not a verdict.

### UI

Subject to the overhaul spec's say-it-once rule: the cause appears in **one** place per row.

- **The activity cell** carries the cause where one exists: `never used · dropped`, `never used · collision`, `never used · not measurable`. Where the cause is `unused` the cell reads as it does today — the residual needs no qualifier.
- **The `prune` view groups by cause**, most-actionable first, so the shortlist stops mixing a listing-budget casualty with a genuinely unwanted skill. Its headline count becomes the `unused` residual, not the raw never-fired total.
- **`collision` renders its pair inline** — the other asset's name and both fire counts — because a collision that does not name its counterpart is not verifiable.
- **No new colour rule.** Causes use the tones the page already carries.

## Non-goals

Merging, rewriting or deleting a colliding description — that is skillet's job and the boundary is unchanged. Similarity scoring in any form. Cross-kind collision detection (a skill and an agent do not compete for one dispatch). Retroactive recovery of agent fires from before the fix beyond what surviving transcripts already yield. Any change to the cost model, the security engine, or `toggle.ts`.

## Risks

1. **Widening the wrong gate deletes a privacy boundary.** The first draft of this spec proposed replacing `NAME_RE` outright, which would have admitted `"impeccable teach --project ~/clients/acme"` to a durable on-disk ledger — the exact string `unit-ledger.mjs:451` exists to refuse. The channel split above is the mitigation, and the six existing `NAME_RE` assertions must survive the change untouched. If an implementer finds themselves editing those assertions, the implementation is wrong, not the test.
2. **Fixing measurement changes the headline number, and users will notice.** Agents that read as never-used may start showing fires. This is the fix working. The growth view already renders a per-scan delta, and the change should be legible there rather than appearing as unexplained drift.
3. **Part B's causes could become a scoring system by accretion.** Each is a cited fact today. Any future cause that cannot cite a source or needs a tuned threshold does not belong in the list.
4. **The residual is the real product.** If `prune` keeps leading with 172 rather than the 16-item residual, the diagnosis has been added without the benefit being delivered.

## Testing

**Part A**

- A fixture agent named `LinkedIn Content Creator` dispatched via `Agent` with `subagent_type` produces exactly one usage row and one event. Pinned against **both** writers — transcript extraction and the hook path — because they share the constant and a fix to one is not a fix to both.
- The same, dispatched via `Task`, for the older CLI spelling.
- A name containing U+0000 is refused by both writers; a name of 81 characters is refused; a 60-character name with spaces, `&`, `,` and `/` is accepted on the agent channel.
- **The privacy boundary is unchanged and re-pinned:** `NAME_RE` still refuses `"impeccable teach --project ~/clients/acme"`, and `isLedgerEvent` still refuses an args-shaped name on a `skill` or `command` event. A test asserts the same string is refused on those channels *after* `AGENT_NAME_RE` exists — the regression this spec came closest to causing.
- A pre-existing ledger written under the old narrow rule still loads, and no migration runs.
- A file under `agents/` with no frontmatter `name` produces **no item**, and the "not counted here" caveat is emitted — the two assertions are made together, since today they contradict each other.
- The 62% cost figure is unchanged by the phantom-row fix: those rows carry 0 injected chars, and a regression here would mean the fix removed real cost.

**Part B**

- Each cause resolves in the specified order, asserted by constructing an item that qualifies for two causes at once.
- `unmeasurable` never renders as `0 fires`, and the assertion distinguishes absent from zero rather than testing falsiness.
- Containment is found; a pair at 30% token overlap with no containment is **not** reported. The false-positive floor gains the three agent pairs from the design machine as fixtures that must stay unreported.
- A collision renders both names and both fire counts.
- `prune`'s headline counts the `unused` residual, not the never-fired total.
- Screenshots of the amended activity cell and the grouped `prune` view at 1512×900 before the work is called done.
