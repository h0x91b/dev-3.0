# Full interface onboarding state

## Context

Simplified Mode is temporary onboarding. The original Simplify View preset stored its ids in the same set as personal hides, so removing the preset could discard a personal choice.

## Investigation

`hiddenControls` cannot reveal whether an existing id came from the preset or a personal action. Renderer settings writes send whole snapshots, and host operating-system idle signals do not represent remote browser activity.

## Decision

`src/shared/simplified-interface.ts` separates explicit mode and personal hides while retaining the effective `hiddenControls` union for older readers. Existing ambiguous ids remain personal; fresh installations receive a separate preset, and the first settings read exclusively publishes complete defaults before bootstrap creates project data, without replacing a competing creator’s settings.

`src/bun/interface-onboarding.ts` owns an additive, locked `interface-onboarding.json`; the full read/mutate/write transaction serializes windows. Visible, focused renderers report recent trusted input every 15 seconds; overlapping intervals count once, gaps over 30 seconds earn no credit, and persistent 45-second claims plus conservative renderer expiry prevent duplicate invitations.

## Risks

A legacy preset can remain hidden after switching to Full because its provenance is unknowable; users can restore individual controls or explicitly show all. Older versions can discard unknown settings fields on save, so current code retains the effective visibility set and conservatively treats ambiguous ids as personal on return.

## Alternatives considered

Removing every preset id on opt-in would lose personal hides. Storing reminder timing in whole-settings snapshots would allow unrelated saves to rewind the clock; installation age and host idle time cannot measure active remote use.
