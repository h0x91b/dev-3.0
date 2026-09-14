# Always show the launch account line

## Context

The per-launch account pill (`AgentAccountIndicator`, rendered by `AgentConfigPicker`)
hid itself whenever the harness had no *managed* accounts registered. That looked like
progressive disclosure — one account, nothing to choose — but the popover behind the pill
is also the only place where an account's own limit windows (5h / 7d / monthly) are
readable next to the harness and model fields. A user with one Claude login and one Codex
login therefore saw no usage anywhere in the launch dialog, which is exactly the moment
the numbers decide which harness to launch.

## Decision

The pill renders for every claude/codex harness, including the zero-managed-accounts case
where the only row is the system login (`AgentAccountIndicator.tsx`, the removed
`accounts.length === 0` guard). A harness with no account registry at all — Gemini, Cursor
Agent — still renders nothing: there is no account and no limit to report.

The popover's footer carries one link, "Add another account", which deep-links to
Settings → Accounts (`OPEN_SETTINGS_SECTION_EVENT`). Adding an account is a terminal login
flow (`LoginFlowCard`), so it cannot be inlined here; Settings stays its only home.

Two smaller corrections came with it: `handleProviderChange` drops a per-launch account id
when the harness crosses account registries (a Claude account cannot pay for a Codex
launch), and closing the popover returns focus to the pill.

## Risks

Settings is a screen, not an overlay, so taking the link closes the launch dialog: the
launch surfaces pass `onAddAccount` = close + navigate + an info toast saying nothing was
launched. The variant picks are lost, which is cheap (they are re-derived from the global
defaults) and strictly better than a dialog floating over Settings. The blocked-CLI
approval dialog (`AgentLaunchRequestModal`) passes no handler and shows no link — leaving
it declines a launch a CLI is waiting on.

## Alternatives considered

Showing the line only when a usage reading exists (hides the control exactly when the user
wants to know why there is no reading); embedding the add-account login flow in the popover
(a second place to configure accounts — the header readout's rule against that stands);
persisting the launch draft across the navigation (real machinery for picks that cost one
click each).
