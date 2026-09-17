# Repairing the narrowed Codex profile is offered, never applied

## Context

`ensureCodexConfig` used to write `default_permissions = "workspace"` with
`":minimal" = "read"` into `~/.codex/config.toml` for users who had no
`default_permissions` of their own. That profile is narrower than Codex's own default and
stops standalone Codex from starting a session on a Homebrew install — see
`decisions/2026/09/17/codex-workspace-fallback-must-mirror-codex-default.md` for the
Seatbelt mechanism. Fixing what dev3 writes from now on does nothing for the machines it
already narrowed, and two users hit this within a day of each other.

## Decision

dev3 offers the repair and never performs it unprompted.

`getCodexProfileRepairOffer` (`src/bun/rpc-handlers/settings-config.ts`) returns an offer
only when the breakage is real on this machine: macOS, a Codex binary that resolves through
a symlink, `hasNarrowedWorkspaceProfile` true for the user's config, and no stored refusal.
`CodexProfileRepairModal` then states the file and the exact line (`":minimal" = "read"` →
`":root" = "read"`) before anything is written, and `repairCodexProfile` applies it from the
user's click alone. "Not now" re-offers next launch; "Don't ask again" stores
`codexProfileRepairDeclined` and never does. Repairing clears the condition itself, so the
dialog disappears without a flag.

The dialog is not a new surface pattern: it is the `RosettaWarningModal` shape (a startup
environment condition dev3 can name but must not fix silently) plus §10's blast-radius rule
— a dialog about to write to the user's own files says what it writes and where.

## Risks

A user who dismisses it and never reads the copy stays broken, so the dialog carries the
edit itself and the repair remains available by hand. The offer reads a file dev3 does not
own on every launch; it is one `readFileSync` behind three cheap gates, and any failure
returns "no offer" rather than throwing.

## Alternatives considered

A silent migration on a value fingerprint: rejected, because the shape an older dev3 wrote
is byte-identical to one a user could have written, so it would widen somebody's sandbox on
a guess. A toast: the bible's toast anatomy carries no persistent action, and a transient
message is the wrong carrier for an edit to the user's config. A Settings row alone: a user
whose Codex is broken outside dev3 has no reason to go looking for it.
