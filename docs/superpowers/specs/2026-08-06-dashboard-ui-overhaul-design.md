# Dashboard UI overhaul — sidebar navigation, one statement per fact

**Date:** 2026-08-06
**Status:** Approved design, pre-implementation
**Supersedes:** the *Display* column commitments in `2026-08-04-ui-dashboard-design.md` and `2026-08-05-skill-usage-ledger-design.md`. Every metric those specs define still ships; **where each one appears changes**. Nothing in their engine, capture, or honesty sections is affected.

## What and why

The dashboard accumulated three release-loads of surfaces (v1 inventory, S1 ledger, S2/S3 joins and panels) without its information architecture ever being revisited. Each addition was locally reasonable. The sum is not.

Measured on the live page at 1512×900, before this overhaul:

| | |
|---|---|
| Visible words in header chrome | 133 |
| Numbers on screen before the first table row | 44 |
| Interactive controls on first paint | 159 |
| Hidden explanatory text (`data-tip` + `title`) | **21,357 words across 490 elements** |
| Vertical space consumed before the first row | **576 px of 900 — 64%** |
| Table rows visible | 4–10 depending on window |

Two failures, one cause.

**The wordiness is a misreading of the creed.** Invariant 6 says every figure carries its window / tracked-since / backfill qualifier. That was implemented as *attach the full derivation to every element*. Because everything is equally explained, nothing is learnable — there is no hierarchy telling a reader what matters. On a single-provider machine every row shares one window, so `· 43d` on every column header, every cell tooltip and every drawer line is pure repetition.

**The crowding is caused by horizontal navigation.** Masthead, readout strip, portfolio strip, filter rail and panel bar are five stacked bands, each spending vertical space the table needs. Trimming their padding is whack-a-mole; the structure is the problem. Moving navigation into a left sidebar uses horizontal space the table does not need and removes the competition entirely.

A related symptom worth naming, because it is what prompted this: the portfolio strip was made `overflow-x: auto` to stop it wrapping, which hid content behind a scroller with no affordance. Trading a visible problem for an invisible one is the same error as burying 21,000 words in tooltips.

## Decisions locked during brainstorming (2026-08-06)

1. **Information architecture is rebuilt; the visual identity is not.** `.impeccable.md` remains binding and unamended: brand-tinted near-black, one calibrated amber, hairline structure, engraved labels, tabular figures, the hard-ban list, and the acceptance test ("if a stranger would believe an AI made this, it fails").
2. **Say it once.** Every fact appears in exactly one place, at the level where it applies.
3. **Left sidebar navigation**, content area shows one thing at a time.
4. **Sidebar entries are asset types, then analyses, then security** — which absorbs today's skills↔everything toggle and the kind filter chips into navigation.
5. **A slim, always-on, toggleable stat bar** above the content carries the headline numbers.
6. **The portfolio strip is dissolved**: its genuinely headline fact joins the stat bar; the rest move behind the views they belong to.
7. **The page states its own purpose**, and defines each term where it first appears — in the layout, not in a tooltip.
8. **One activity cell and one cost cell per row**, replacing four columns that restate one fact.
9. **`fires` stays the product's noun.** It is shared with the CLI, README and both prior specs; renaming it is a product-wide change and out of scope here. It gets defined once, in place.

## The layout

```
┌──────────────────┬──────────────────────────────────────────────────┐
│ CONTEXT-AUDIT    │ 8,801 tok/sess · 172 never · 153% ▲ · 33/119 used│  ← stat bar (toggleable)
│ instruction      ├──────────────────────────────────────────────────┤
│ inventory        │  [fired] [never] [off]        find ______        │  ← view controls
│                  ├──────────────────────────────────────────────────┤
│ INVENTORY        │  STATE  NAME             COST/SESSION  ACTIVITY  │
│   all        187 │   ▣     ui-ux-pro-max            232   never …   │
│ ▸ skills      54 │   ▣     impeccable               114   never …   │
│   agents     133 │   ▣     brutal-product-analysis  104   8 · Aug 5 │
│   commands     8 │   …                                              │
│   instructions 2 │                                                  │
│                  │                                                  │
│ ANALYSIS         │                                                  │
│   listing     ▲  │                                                  │
│   prune          │                                                  │
│   providers      │                                                  │
│   growth         │                                                  │
│                  │                                                  │
│ SECURITY         │                                                  │
│   flagged      0 │                                                  │
│                  │                                                  │
│ 43d · 4 caveats  │                                                  │
└──────────────────┴──────────────────────────────────────────────────┘
```

### Sidebar

- **Drawn as an instrument's function selector, not a nav menu.** This is the single highest-risk element in the overhaul: a left sidebar is the most common shape of an AI-generated dashboard, and `.impeccable.md`'s acceptance test fails on sight of one. It must use the page's existing grammar — engraved section labels, hairline separators, tabular counts, the one amber for the active entry. **No icons, no pills, no avatars, no rounded cards, no nested panels, no accent bars.**
- Three sections: **INVENTORY** (all + one entry per asset kind present, with live counts), **ANALYSIS** (listing, prune, providers, growth), **SECURITY** (flagged, with its count).
- An entry appears only when it has something to show. A machine with no Cursor rules gets no rules entry; `providers` and `growth` do not appear when the payload cannot populate them. This is the existing "panels with no data never appear" rule, applied to navigation.
- A mark rides an entry when that view holds a state the page already treats as one — an over-budget listing, a critical/high finding — using the tones those two facts already carry elsewhere (the listing readout's over-budget tone; the findings severity tone). No new colour rule is introduced, and no other entry is ever marked.
- The footer carries the window span and the caveat count, both leading to the provenance statement.
- Fixed width; does not collapse. (A collapsing sidebar is a second navigation state to design, test and explain, for a page that has room.)

### Stat bar

- One shallow row: **cost per session · never fired · listing budget · sessions that used anything**. Flagged is not here — it is a sidebar section with its own count.
- `inventory: 187 files` is **not** a headline figure. It moves into the provenance statement, where it is context rather than a finding.
- Always on by default and toggleable. The toggle lives in `AppState` like every other view state — **no new persistence mechanism**; it does not survive a reload, and that is acceptable. Toggling it off must not change any figure, only whether it is drawn.
- Each figure is clickable, navigating to the view that explains it. This is additive to the sidebar, never the only route to anything.

### Content area

One view at a time. The inventory views render the table; the analysis views render their panel on the same canvas. Every view owns the full content area — no view is nested inside another.

**View controls** sit in one compact row above the content: the activity lens (`fired` / `never fired` / `off`), and search. `flagged` leaves the lens — it is a sidebar destination. Kind and scope leave entirely — they are the sidebar.

### Drawer

Stays as the per-item detail surface — an inline disclosure, which `.impeccable.md` prefers over a modal. It is **reorganised by question, not by data source**, and is subject to the same say-it-once rule: a fact stated in the stat bar, the provenance line or the row is not restated in the drawer.

## The qualifier rule

This is the rule that licenses deleting most of the page's text, so it is stated precisely.

**Invariant 6 is restated as:** *no figure may be presentable as something it is not.*

That is satisfied by two mechanisms, not by repetition:

1. **One provenance statement**, always reachable and stated in full on the default view, covering: how many transcripts were read, the window they cover, when durable tracking began, and what a *fire* is.
2. **A deviation mark on any figure that does not match it.** The complete list of deviations:
   - measured over a **different provider's window** than the page-level one;
   - **backfilled** — imported rather than observed;
   - **modelled** — our reconstruction standing in for something the harness keeps private (the listing cut order);
   - **unmeasured** — absent, which is not zero;
   - an **upper bound** rather than a reading (a ctime-derived disable date);
   - **approximate** by a stated method (per-agent token cost).

One consistent visual mark, one consistent surface that explains it. A figure that matches the page-level provenance carries **nothing**.

**What this deletes:** `· 43d` on every column header and cell; the window note repeated in every tooltip; the method sentence on every drawer line; the three-way restatement of "never fired". **What it must not delete:** any of the six deviations above. If an implementer cannot tell whether a qualifier is a deviation or a repetition, it is a repetition only when removing it leaves the figure still true at a glance.

## The table row

Today a never-fired row states one fact three times, in three phrasings, each with its own window suffix:

```
fires: never · installed 47d    tok/fire: paid 90,383 · never fired    last fired: none in 43d
```

Replaced by:

```
STATE   NAME                       COST/SESSION   ACTIVITY              FLAGS
  ▣     ui-ux-pro-max  ▸dropped            232    never used · 47d old    —
  ▣     brutal-product-analysis             104    8 fires · last Aug 5 ↗  —
```

- **Cost** and **activity** are the two questions; they get one column each.
- The activity cell answers "is this used?" once, in one phrasing, and carries the trend glyph where a trend exists.
- `tok/fire` stops being its own column. It is a derived ratio, and it belongs in the drawer and in the prune view, where the cost question is the subject.
- Badges appear only when their fact does, as today. `▸dropped` (listing-dropped) is a state worth keeping inline because it explains why a skill stopped auto-triggering.
- The window is not repeated in any cell.

## Vocabulary and teaching

- The page states its purpose in one plain sentence, on the default view: what this is, and what to do with it.
- Each term is defined **at its first appearance, in the layout** — not in a tooltip, not in a modal, not in a dismissible tour. A definition that only exists on hover does not exist for a first-time reader, and one that must be dismissed is one the reader will dismiss before reading.
- Terms requiring a definition: **fire**, **cost per session** (what "always in context" means), **window**, **tracked since**, **listing budget**, **dead weight**.
- `fires` is retained (decision 9). Where the plainer word is genuinely clearer *and* unambiguous — "never used" for the zero case — it may be used, provided the count case still reads "N fires" so the vocabulary stays consistent with the CLI.

## What is removed

The portfolio band · the panel bar · the skills↔everything toggle · the kind filter chips · per-column window suffixes · the `tok/fire` column · the two-line listing-cut divider · the three-way restatement of never-fired · tooltips as the *default* explanation mechanism · the horizontal scroller on the portfolio strip.

## Out of scope

- **The engine and the payload.** `src/ui/inventory.ts` and everything under it was adversarially reviewed on 2026-08-06 and is correct. Payload changes are permitted **only** where the UI needs a fact it cannot derive — the known candidate is a per-provider session total, which the drawer's breadth share and `tok/fire` currently withhold for Cursor rows because no comparable denominator exists. Any such addition follows the existing types.ts documentation style.
- **The CLI, the report, and the README.** Vocabulary stays consistent with them; they are not edited here.
- **The visual identity.** `.impeccable.md` is unamended and binding.
- **New runtime dependencies.** None. `render.ts` and anything it imports stay DOM-free — the frontend smoke test imports them into Node with no browser.

## Risks

1. **The sidebar reads as a SaaS console.** Highest risk, stated above. Mitigation: build it from the page's existing components and check it against `.impeccable.md`'s hard-ban list explicitly before shipping. If it cannot be drawn instrument-grade, that is a finding worth reporting, not something to ship past.
2. **The screenshot is the launch asset**, and fewer numbers on screen could weaken it. Mitigation: the readouts get larger, the table roughly doubles its visible rows, and the sidebar gives the page a structure a screenshot can show. Verify by screenshot before claiming done.
3. **Deleting text is where honesty gets lost.** The qualifier rule above is the test. Every deletion must be checkable against it, and the six deviations are not negotiable.
4. **Test churn.** `test/unit-render.mjs` carries 171 assertions, many pinning current strings and layout. They break by design. They are **rewritten to pin the new rules** — the qualifier rule, the deviation marks, the definitions being present in layout rather than in tooltips — not patched to match whatever the new markup happens to say. The hostile-payload escaping pass and the DOM-free contract are kept as-is.

## Testing

- Every honesty assertion in the current suite is re-expressed against the new surfaces: absent ≠ 0 ≠ tracked-zero; unknown never renders as "unchanged"; a modelled figure says so; a per-conversation timestamp says so; per-provider windows caption their own columns.
- New assertions: the provenance statement is present and complete; a figure matching page-level provenance carries no qualifier; each of the six deviations renders its mark; each defined term's definition appears in the rendered markup, not only in an attribute.
- A layout assertion pinning the chrome budget, because this is exactly what regressed silently and it is cheap to pin: at 1512×900 the first table row must begin **within the top 30% of the viewport** (it was 64%). Measured via CDP against the real bundle, not asserted on markup.
- Screenshots at 1512×900 and one narrow width, for every sidebar entry, before the work is called done.
