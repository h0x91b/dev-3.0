# Session-Start Checklist Anchored to an Event

## Context

Agents kept silently dropping the title-rename step (and, for scratch tasks, sometimes overview/labels) when the user opened with a concrete task instead of letting the agent run a "setup" turn. Overview survived because it has its own standalone MANDATORY section; title lived only inside the scratch-onboarding ritual and the conditional "Title generation" section, both of which the agent races past.

## Investigation

Root cause was structural, not a wording typo: the title instruction was (a) nested inside a ritual the agent skips under task pressure and (b) anchored to "Run ONCE at session start", a phrase the agent overruns the moment real work appears. The instructions that *did* fire were anchored to detectable events and placed independently.

## Decision

In `src/bun/agent-skills.ts` (`SKILL_CONTENT`): add a front-loaded `## Session-start checklist` (branch / title / overview / labels) with a hard gate anchored to an **event** — "finish before you end your first turn" — not "at session start". Couple title-setting to the initial-overview moment ("same pass as the title and labels") so it rides on a step the agent reliably performs. Reword the overview "keep current" rule to trigger on **material state changes** rather than a per-message count (agents have no reliable cross-turn counter). Regression tests in `src/bun/__tests__/agent-skills.test.ts`.

## Risks

Prompt-level reinforcement is probabilistic, not enforced — a Stop hook would be the deterministic fix (deferred; the user chose the prompt-only approach for now). Slightly longer skill body injected into every agent system prompt; negligible.

## Alternatives considered

Standalone title section parallel to Overview: rejected in favor of coupling title to the overview step + the checklist (less duplication). Stop hook that re-injects a staleness reminder each turn: deferred — reliable but needs app code; revisit if the prompt-only approach still misses.
