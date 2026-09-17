# The narrowed Codex profile is repaired on startup, not offered

## Context

`ensureCodexConfig` used to write `default_permissions = "workspace"` with
`":minimal" = "read"` into `~/.codex/config.toml` for users who had no `default_permissions`
of their own. That profile is narrower than Codex's own default and stops standalone Codex
from starting a session on a Homebrew install — the Seatbelt mechanism is in
`decisions/2026/09/17/codex-workspace-fallback-must-mirror-codex-default.md`. Not writing it
any more fixes nothing for the machines already carrying it, and those are the broken ones.

## Investigation

The first implementation asked first: a startup dialog naming the file and the line, with
"Not now" and "Don't ask again". The reasoning was that the profile dev3 wrote is
byte-identical to one a user could have written by hand, so repairing it silently would be
widening someone's sandbox on a guess.

The owner rejected the dialog outright — "we put it there, we take it out" — and that is the
better reading: dev3 does not ask permission to undo its own damage, and a dialog for a
condition dev3 created is a prompt about dev3's mistake, shown to somebody who never chose
the setting in the first place.

## Decision

`ensureCodexConfig` repairs it in place. When `default_permissions` is already
`"workspace"` and `hasNarrowedWorkspaceProfile` matches — that profile's only filesystem
grant being `":minimal" = "read"` — the grant is upserted to `":root" = "read"`, which is
what Codex grants when no profile exists at all. It happens in the same pass that patches
everything else in that file at startup, so there is no new surface, no setting, and nothing
to dismiss. A repaired config matches nothing on the next launch, so it is written once.

## Risks

A user who hand-wrote exactly that profile — `default_permissions = "workspace"`, one
filesystem grant, `:minimal` read — gets their Codex read scope widened to Codex's default
without being asked. The fingerprint is deliberately exact so anything else is left alone,
and the change is logged.

## Alternatives considered

A consent dialog (built, then removed — see the Investigation above). A Settings row: a user
whose Codex is broken outside dev3 has no reason to go looking for one. Doing nothing and
waiting for upstream: leaves every already-narrowed machine broken.
