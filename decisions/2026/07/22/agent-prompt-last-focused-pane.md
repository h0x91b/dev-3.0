# 154 — Route agent hand-offs to the last-focused agent pane

## Context

`resolveAgentPromptTargetPane` (`src/bun/agent-prompt.ts`) picks the pane every
hand-off is typed into: the diff "Send to Agent", Create-PR / auto-merge prompts,
rebase-conflict handoff, scheduled-message delivery. With two or more agent panes
it fell back to tmux's *currently active* pane, so a hand-off sent right after the
user clicked a shell / dev-server split landed in that split instead of an agent.

## Investigation

Extra agents live as `split-window` panes in one tmux window (`spawnAgentInTask`).
tmux has `focus-events on` already and exposes `after-select-pane`, which fires on
every focus change (mouse, Alt+arrow, programmatic `select-pane`). The dev3 tmux
server hosts many task sessions on one socket, so any state must be session-scoped.
Verified live on a scratch socket: a global `after-select-pane` hook writing a
session-scoped `@dev3_last_agent_pane` correctly (a) expands `#{pane_id}` with
`set -F`, (b) keeps the previous value via a `#{?@dev3_agent,…}` conditional when a
non-agent pane is focused, and (c) does not leak across sessions.

## Decision

Mark every agent pane with the pane option `@dev3_agent=1`
(`markAgentPane`, called at `persistInitialAgentPaneId` + `spawnAgentInTask`, and
self-healed for all live agent panes inside `resolveAgentPromptTargetPane`). A
config hook (`src/bun/tmux/config.ts`) records the last-focused agent pane into the
session option `@dev3_last_agent_pane`; resolution prefers it when it is still a
live registered agent pane, else falls through to the prior rules (single agent →
it, unresolved main → pane[0], ≥2 → active pane). Option names are exported
constants shared by the config and the resolver. New client methods:
`setPaneOption` (`set-option -p`) and `showOption` (`show-options -v -q`).

## Risks

Message routing is sensitive (issue #609). Mitigated by graceful degradation: a
missing marker or empty option falls back to today's exact behavior. The hook only
lands on servers that (re)sourced the updated config; older running sessions keep
the old behavior until reconfigured — acceptable, non-breaking.

## Alternatives considered

- **Record last-focused pane of ANY kind** (no `@dev3_agent` marker): simpler
  quoting, but can't remember the prior agent once a shell is focused — misses the
  user's core ask.
- **Heuristic only** (focused agent → it, else pane[0]): no per-session state, but
  never targets a *different* last-used agent when the user is sitting in a shell.
- **App-tracked MRU via a CLI round-trip on each focus**: captures in-terminal
  focus too, but spawns a process per focus change — far heavier than a pure-tmux
  hook that costs nothing at runtime.
