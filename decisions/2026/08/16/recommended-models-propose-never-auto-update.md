# Curated model recommendations are proposed, never auto-applied

## Context

`RECOMMENDED_MODELS` in `src/shared/recommended-models.ts` is a hardcoded list. Connecting
OpenRouter seeds it into the catalog and writes a **Best value** preset into Claude Code and
Codex. The list changes with releases; the presets it produced live on the user's machine and
are what their sessions actually run on.

## Investigation

Three behaviours were possible for an already-seeded user when the list moves: leave them
behind forever, rewrite their preset on update, or ask. Rewriting is the one that looks
helpful and is not — the models behind a preset decide both the bill and the quality of the
work, and an app update is not consent to change either. Leaving them behind is safe but
means the curated list only ever helps people who installed after it changed.

## Decision

The list carries `RECOMMENDED_REVISION`; a seeded preset stores `seededRevision`
(`AgentConfiguration`). `catalogForCurrentRevision` + `pendingPresetUpdates` compute what
*would* change without saving anything, and `AgentConfigPicker` shows a one-line notice on the
preset it would rewrite — only there, and only where that preset is about to be used.
`RecommendedUpdateModal` shows both sides per role; `applyPresetUpdates` writes on approval,
`markRevisionSeen` writes on decline.

Declining stamps the same revision. The question is "has this user been asked about revision
N", not "is this user on revision N" — a decline that left the stamp behind would re-ask on
every launch, which is how a prompt becomes noise the user learns to click past.

## Risks

A user who declines never hears about that revision again, even if they later change their
mind; the preset editor remains the way to rebind by hand. Bumping the revision for a cosmetic
edit would prompt everyone for nothing — hence the "do not bump for a label or price fix" rule
next to the constant.

## Alternatives considered

Auto-apply on update (rejected: silent cost and quality change). A second preset alongside the
old one (rejected: presets accumulate, and the launcher's Model list is the surface that pays).
Storing a snapshot of the seeded bindings to detect hand edits (rejected: the modal already
shows the user's own current binding as the `from` side, which is the same information without
a second source of truth).
