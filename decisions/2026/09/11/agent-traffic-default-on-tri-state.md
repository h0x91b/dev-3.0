# Agent traffic ships on, and its setting becomes tri-state

## Context

`experimentalAgentTraffic` shipped as an off-by-default beta. The feature is now good enough
to be on for everyone, but the Settings switch must keep working as a real opt-out.

## Investigation

The field was stored as `true | undefined`: the sanitizer in `src/bun/settings.ts` kept only an
explicit `true`, and the toggle handler in `GlobalSettings.tsx` wrote `undefined` for "off". So
"the user turned it off" and "the user never chose" were byte-identical on disk. That is fine for
a default-off flag and fatal for a default-on one.

## Decision

The field becomes tri-state, following the `lowBatteryEnabled` precedent: the sanitizer keeps any
boolean, the toggle writes `enabled` directly, and every reader treats absent as on
(`!== false` in `src/mainview/agent-traffic-flag.ts` and `AdvancedExperienceSection.tsx`). The
module flag in `agent-traffic-flag.ts` initialises to `true` so the pre-settings render matches
the default.

## Risks

Opt-outs recorded **before** this change cannot be honoured — they were stored as "no key", which
is indistinguishable from a fresh install, and no other on-disk trace of the choice exists. Those
users get the feature back on and must switch it off once more; from then on the choice sticks.
How many installs that affects is unknown — nothing on disk or in telemetry counts them. No migration
can recover the difference, and guessing (e.g. treating any user with stored settings as an opt-out)
would silently hide the feature from everyone who never touched it.

## Alternatives considered

Writing a `agentTrafficDisabled` legacy key at load time for existing installs — rejected, it
would have to guess which installs opted out, and rule 3 of the on-disk layout invariants forbids
inventing user state during a load-time migration. Leaving the beta off — rejected, that is the
task.
