Superseded on 2026-11-01 by `decisions/2026/11/01/inactive-task-hibernation-suggestions.md`: grouped, timed suggestions replace silent hibernation; viewing no longer counts as activity.

# Auto-hibernate only observably inactive tasks

## Context

Manual hibernation frees task agents, terminals, dev servers and ports while preserving the worktree and conversations. Users also need an optional inactivity timeout without approving each hibernation individually.

## Decision

The global policy lives in Settings → Tasks & Board, is off by default, and accepts 1–43200 whole minutes. A 30-second backend scheduler watches waiting built-in columns; working, preparing, disconnected, hibernated, draft, custom-column and Keep alive tasks are excluded.

`task-activity.ts` records agent hooks and user input through a dedicated renderer RPC. Focused views send a heartbeat, and tasks with live dev servers stay awake even when the server prints nothing. The policy pauses while another dev3 instance is alive, since per-instance clocks cannot establish shared inactivity safely.

The activity probe reads tmux clocks across every task pane, or native clocks only when every pane is observed; unknown activity postpones hibernation. A policy-owned callback rechecks activity inside the lifecycle actor before teardown. Automatic hibernation omits the cwd-wide process reaper: only manual confirmation authorizes killing unrelated processes in the worktree. A localized toast identifies automatic hibernation.

## Risks

Terminal scrollback is lost, which the opt-in setting explains; waking remains explicit. In-memory observation windows restart after app restart or policy changes, deliberately giving detached tasks a full timeout. Unobserved native panes, live dev servers and multiple instances can postpone hibernation indefinitely; this is preferable to silently interrupting work.

## Alternatives considered

Using `updatedAt` alone would miss typing and agent activity that does not move a card. Inferring inactivity from silence while an agent is working could interrupt a long tool call. Sharing every activity event across processes would add state writes and coordination; pausing in the presence of peers is the conservative alternative. Reusing manual hibernation's cwd reaper was rejected because unsaved editors and unrelated shells can hold the same worktree.
