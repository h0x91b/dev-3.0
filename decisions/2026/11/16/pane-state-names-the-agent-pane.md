# Pane state names the agent's pane, and a reveal action brings it back

## Context

A renderer that needs the task's main agent pane (the inline completion bar of #2257 is the first) had only pane order to go on. A swap moves the agent anywhere in that order. A zoom on another pane, or a tmux agent in a window that is not active, hides the agent's pane, and the existing `focus` action selects a pane without switching windows.

## Decision

`TaskPaneState.agentPaneId` names the main agent's pane while it lives anywhere in the task's session, and is null once it is gone (absent when the task is unknown). Both backends fill it through `mainAgentPaneId` (`src/bun/agent-message-target.ts`), the rule that already routes task-addressed messages: on tmux the first `sessionState` entry, checked against the panes of every window; on native `pane-1` while alive. A new `reveal` pane action brings a pane into view: tmux `select-window` then `select-pane`, which lifts a zoom in that window; native unzooms the tree when another pane is zoomed, then focuses.

The renderer piece (the bar framing `agentPaneId` and offering Show agent through `reveal`) lands with #2257, which owns the bar.

## Risks

`select-pane` lifting a zoom is tmux behaviour, checked on 3.6a.

## Alternatives considered

Letting the renderer pick the agent pane from pane order or layout index: that is what a swap breaks.
