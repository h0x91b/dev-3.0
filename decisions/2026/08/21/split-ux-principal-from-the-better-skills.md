# Split `ux-principal` from the `better-*` skills, and rule on their three conflicts

## Context

`AGENTS.md` required `/ux-principal` before **anything** visible. The `better-*` skill family
(`better-accessibility`, `better-colors`, `better-typography`, `better-writing`, `better-layout`,
`better-ui`, plus the `better-interface` orchestrator) arrived later and covers the same craft
domains far more deeply. Nobody had reconciled the two, so a one-line badge tweak paid a full
manifest read — 307 KB, roughly 77k tokens — for rules it was never going to break, and two
skills gave conflicting instructions on the same code.

## Investigation

Audited both sides rule by rule. Six domains are duplicated (colour/contrast, accessibility,
typography, copy, motion, layout grammar) and the `better-*` version is deeper in every one.
Six areas are `ux-principal`'s alone and nothing in `better-*` touches them: placement, action
taxonomy, navigation rules, complexity budgets, the object model, and 7 of 9 anti-patterns.
`better-interface` is a read-only post-hoc review with no placement domain, so it is a different
lifecycle phase, not a replacement. Exactly three genuine contradictions existed, all
`better-ui` vs this repo: borders-vs-shadows for depth, motion restraint vs the deliberately
looping icon families, and prescribed motion primitives against a repo with no motion library.

**A first pass got the manifest itself wrong, and the correction is the more useful finding.**
Judging `ux-architecture.yaml` by its top-level keys — which mirror the bible's sections — and
by its citation count, it looked like a machine-readable duplicate worth deleting. Reading its
*content* disproved that: a 38-line sample found 36 lines with no counterpart in the bible, 7
of 10 distinctive concepts were absent there, and the yaml carries 29 `allowed` / 28 `forbidden`
admission lists across ~101 surfaces where the bible mentions "forbidden" six times and has no
such structure. The card's five-zone model, the shortcut editor's two-slot rules, the inline
review's TTL and sent-stickiness all live only in the yaml. What made it look disposable was its
own header: `source: derived_from_repository`, `confidence: medium`, `updated_at: 2026-07-13` on
a file edited weekly across 66 commits. The bible had the same defect from the other side — its
`Observed` markers describe where a claim came from, and were read as "restates the code".

Separately: the July 2026 doc diet (`ux-skill-doc-diet.md`, PR #792) cut `docs/ux` to 131 KB and
wrote a ~35 KB cap plus a compaction duty on `UX_DECISIONS.md`. Seven weeks later the tree was
307 KB, the log 92 KB across 105 entries (was 46), and one `feature-plans/*.md` had come back in
PR #906 after that same PR deleted twenty of them. Convention alone did not hold.

## Decision

**Split by phase.** `ux-principal` decides *where* a thing goes before it exists and is mandatory
only for a change that adds a destination, surface, or action, or pushes a complexity budget.
Craft on an existing control goes straight to the owning `better-*` skill; `/better-interface`
reviews a whole screen. Wired into `AGENTS.md` as a three-row table.

**Craft rules deleted from the skill.** `references/visual-token-decision.md` is gone, as is the
accessibility sub-agent brief; the report's accessibility section became "handed to the craft
skills". The skill now names a semantic role plus the project's existing token class and stops.
Bible §9a was rewritten from a general quality-floor rulebook into dev3's deltas only — the
Tailwind `focus:outline-none` specificity trap, `MOBILE_DENSE_FACTOR`, the composited-alpha
contrast rule, the no-skip-link and capped-pinch-zoom exceptions, the ru/es 1.9× string growth.

**The three conflicts are ruled and recorded** in `AGENTS.md`, bible §9a.0, and `DESIGN.md`:
`better-ui` wins on borders-vs-shadows (a border may not fake depth; structural and state borders
stay, glass morphism is untouched) and on motion primitives (its exact values, via its no-library
CSS path). dev3 wins on the looping `tmx-`/`gtx-`/`hdr-`/`th-` hover animations — that is a
deliberate personality choice and not a finding.

**Headers now say what the files are.** The yaml declares `source: hand_authored_decisions`
with a comment naming the admission lists as its reason to exist, and its `updated_at` /
`confidence` fields are gone — a hand-maintained date is what caused the misread. The bible's
preamble states that `Observed` is provenance, not disposability. `ux-create-manifest` is told
never to stamp a generated-looking header on hand-authored content.

**`UX_DECISIONS.md` folded to an index.** The 24 entries whose reasoning now lives in a
`decisions/` record became two-line pointers (rule in one clause + where it lives + the record):
94.8 KB → 76.2 KB. The other 84 entries keep their full text deliberately — no record exists for
them, so their why lives nowhere else and compacting them would mean deleting it.

**The doc budget is now a test:** `src/bun/__tests__/ux-docs-budget.test.ts` ratchets each file's
size, caps the tree, and rejects any fourth file or directory under `docs/ux/`. The stale
`feature-plans/agent-favorites.md` was deleted, as PR #792 already intended.

## Risks

The `better-*` skills live in `~/.agents/skills`, outside this repo — if they vanish, the deltas in
§9a are all that survives, which is why §9a keeps them rather than deleting the section outright.
The borders-vs-shadows ruling is recorded but **not migrated**: 410 `border border-edge` call sites
across 161 files, most of them structural, so a blanket replace would flatten the visual identity.
New surfaces follow the rule now; existing ones migrate family by family with QA in both themes.
The size budgets are set at today's sizes, so they stop growth without forcing the compaction pass
that `UX_DECISIONS.md` (92 KB against its own 35 KB prose cap) still needs.

## Alternatives considered

Deprecating `ux-principal` entirely and mandating `better-interface` + `better-ui` — rejected: it
drops placement, action taxonomy, navigation rules and complexity budgets with nothing replacing
them, and swaps a planning pass for a post-hoc review. Reducing `ux-principal` to a ~40-line router
— rejected for now: it also loses the report format and the rejected-placements discipline, which
are what make the output specific enough to hand a coding agent. Leaving it alone — rejected: the
three conflicts get re-litigated in every UI task and the docs keep growing.
