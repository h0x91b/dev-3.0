# 179 — PR Babysitter: autonomy levels enforced by prompt composition

## Context

Phase 1 of native PR babysitting (end-state spec in design task notes, seq 9): the built-in
`review-by-colleague` column becomes the active babysitting phase. On entry, a column agent
must handle the open PR with user-controlled aggressiveness — from read-only diagnosis to
arming auto-merge — without new enforcement machinery.

## Decision

- **Autonomy is a 3-level preset over 6 capability booleans** (`push`, `reply`, `resolve`,
  `rebase`, `rerunChecks`, `armAutoMerge`): Triage = all off, Fix (default) = push/reply/rebase,
  Land = all on. Sparse `overrides` sit on top; the UI shows "Custom" when any override diverges.
  Config lives in a new additive `babysitter` field on `Project` + `.dev3/config.json`
  (`composeBabysitPrompt`, `BABYSITTER_AUTONOMY_PRESETS` in `src/shared/types.ts`).
- **Enforcement is prompt composition, not code**: each capability emits a MAY/NOT line into the
  generated prompt; hard ceilings (never merge/`--admin`/approve, never edit CI/tests/timeouts to
  go green, never touch drafts, `--force-with-lease` only after a legit rebase, reply before
  resolve, park via `dev3 task move --status user-questions`) are appended verbatim to EVERY
  prompt — they are policy, not knobs.
- **Default is read-only Triage** (absent `babysitter` = Triage; `off` is an explicit opt-out).
  Triage makes zero GitHub writes, so shipping it on by default is safe on upgrade; anything
  that writes to the PR (Fix/Land) stays opt-in. Comments are ALWAYS monitored when the level
  cannot reply — triaged and drafted into a task note, never posted; the Handle-comments toggle
  only governs reply-capable levels (user ruling during phase 1 review).
- **No `onExitCommand`** for the babysitter pane (`columnAgentConfig` in
  `src/bun/lifecycle/executor.ts`): the PR is still in review when the run ends, so the task must
  stay in the column; the prompt itself parks to `user-questions` when a human is needed.
- **The working-hook guard was widened** to `--if-status-not review-by-ai,review-by-colleague`
  (claude hooks, codex hook handler, dev3 skill status line): otherwise the babysitter's first
  tool call yanks the task to `in-progress`, and its Stop hook then re-routes it to review
  columns. Side effect: user prompts to the primary agent while the task sits in PR Review no
  longer flip it to `in-progress` — intended, the column now means "PR open".

## Risks

- Prompt-level enforcement depends on agent compliance; a hostile/buggy agent could exceed its
  grants. Accepted for phase 1 (same trust model as every other column agent).
- The widened hook guard changes primary-agent status behavior in `review-by-colleague` (above).

## Alternatives considered

- Granular flags only (no presets) — config sprawl, rejected in design (task seq 9 notes).
- Single on/off toggle — cannot distinguish diagnose-only from force-pushing.
- Capability enforcement in code (e.g. intercepting gh/git) — heavy, brittle, out of scope;
  prompt composition needs zero new machinery.
