# An unbound Claude role slot runs on the launch model, not on its own Claude id

## Context

A Claude Code preset can bind some catalog models and leave other slots
`Unassigned` (`PresetModelRoles`). The launch plan redirects `ANTHROPIC_BASE_URL`
for the whole session, so every slot goes to the proxy — including the ones no
catalog model was bound to. Those kept Claude Code's built-in ids
(`claude-haiku-4-5`), which no configured provider serves.

## Investigation

Claude Code uses the haiku slot for titles, summaries and background work, so the
session starts fine and fails partway through with a proxy error nobody connects
to the preset. `codexPlan` already guarded exactly this (`wire.subagent ??
wire.main`); `claudePlan` did not, and a test asserted the unbound slot was left
alone. `recommended-models.ts` states the same consequence and works around it by
refusing to seed a partial binding — the hand-editing UI had no such guard.

## Decision

`claudePlan` (`src/shared/model-catalog.ts`) now emits
`ANTHROPIC_DEFAULT_<ROLE>_MODEL` for **every** Claude slot: its own binding when
it has one, otherwise the model the launch itself names (`claudeLaunchSlot` — the
slot the preset meant, else the most capable bound one). The same value the
`--model` flag carries, so the session runs on one explainable model.

## Risks

A slot implying a cheap tier can now run on an expensive model: binding only
`opus` sends background haiku traffic to the opus-tier model. That is a bill, not
a breakage, and it is visible in the preset the user built. The alternative —
blocking a partial binding in the UI — was rejected because it forbids a setup
that now works.

## Alternatives considered

- **Per-slot tier fallback** (an unbound haiku falls to the cheapest bound model):
  needs a capability order the catalog does not have; the ordering would be
  invented, and a wrong guess is a silent quality regression.
- **Refuse the launch on a partial binding**: turns a working configuration into
  an error, and `resolveModelRoleLaunch` deliberately accepts one bound role.
- **Leave it and warn in the UI**: a warning does not stop the mid-session
  failure, and the failure is invisible in the terminal until it happens.
