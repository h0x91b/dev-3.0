# Pane state names the agent's pane, and a reveal action brings it back

## Context

A renderer that needs the task's main agent pane (the inline completion bar of #2257 is the first) had only pane order to go on. A swap moves the agent anywhere in that order. A zoom on another pane, or a tmux agent in a window that is not active, hides the agent's pane, and the existing `focus` action selects a pane without switching windows.

## Decision

`TaskPaneState.agentPaneId` names the main agent's pane while it lives anywhere in the task's session, and is null once it is gone (absent when the task is unknown). Both backends fill it through `mainAgentPaneId` (`src/bun/agent-message-target.ts`), the rule that already routes task-addressed messages: on tmux the first `sessionState` entry, checked against the panes of every window; on native `pane-1` while alive. A tmux task with no registry (a harness without session hooks, or Codex before its hook fires) falls back to its live pane with the lowest numeric `%N`, not to the first pane tmux lists: `swap-pane` reorders that list (`0 %0, 1 %1` becomes `0 %1, 1 %0`), and tmux does not reuse a pane id within a server, so the oldest live pane is the one the task was created with while it lives. A new `reveal` pane action brings a pane into view: tmux `select-window` then `select-pane`, which lifts a zoom in that window; native unzooms the tree when another pane is zoomed, then focuses.

The renderer piece (the bar framing `agentPaneId` and offering Show agent through `reveal`) lands with #2257, which owns the bar.

## Risks

`select-pane` lifting a zoom is tmux behaviour, checked on 3.6a. With no registry, if the creation pane exits and a shell split survives, the oldest live pane is that shell; message routing has the same fallback.

## Alternatives considered

Letting the renderer pick the agent pane from pane order or layout index: that is what a swap breaks.
