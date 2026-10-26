# Auto-hibernate only observably inactive tasks

## Context

Manual hibernation frees task agents, terminals, dev servers and ports while preserving the worktree and conversations. Users also need an optional inactivity timeout without approving each hibernation individually.

## Decision

The global policy lives in Settings → Tasks & Board, is off by default, and accepts 1–43200 whole minutes. A 30-second backend scheduler watches waiting built-in columns; working, preparing, disconnected, hibernated, draft, custom-column and Keep alive tasks are excluded.

`task-activity.ts` records agent hooks and user input, including throttled task interaction from desktop and remote renderers. `auto-hibernate.ts` reads tmux window activity across all panes, or native output clocks only when every native pane is observed; unknown activity postpones hibernation. `lifecycle/service.ts` rechecks the current policy, task state and activity inside the task actor before executing the ordinary hibernation transition.

## Risks

Terminal scrollback is lost, which the opt-in setting explains; waking remains explicit. In-memory observation windows restart after app restart or policy changes, deliberately giving detached tasks a full timeout. A native pane not observed by this process stays awake until all its panes can be measured. Other installations do not coordinate this process-local policy clock.

## Alternatives considered

Using `updatedAt` alone would miss typing and agent activity that does not move a card. Inferring inactivity from silence while an agent is working could interrupt a long tool call. Persisting every activity event would generate frequent state writes; the scheduler instead keeps clocks in memory and starts conservatively after a restart.
