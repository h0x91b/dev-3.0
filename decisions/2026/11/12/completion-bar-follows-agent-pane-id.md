# The completion bar follows the agent's pane id

## Context

The inline completion bar (`completion-offer-style-setting`) took the pane with the lowest layout index as the agent's. A swap moves the agent anywhere, so the bar then sat over a shell. A zoom on any pane, or a tmux agent in a window that is not active, put the bar over a pane the agent is not in, with the agent's report out of sight.

## Decision

`TaskPaneState.agentPaneId` names the main agent's pane while it lives anywhere in the task's session, and is null once it is gone. Both backends fill it through `mainAgentPaneId` (`src/bun/agent-message-target.ts`), the rule that routes task-addressed messages: on tmux the first `sessionState` entry, checked against the panes of every window; on native `pane-1` while alive. `agentPanePlacement` (`TaskCompletionStrip.tsx`) frames that pane. When the agent's pane is out of view (another pane zoomed, or another tmux window), the bar spans the terminal and an agent offer gains Show agent, a `reveal` pane action: tmux `select-window` then `select-pane`, which lifts a zoom in that window; native unzooms the tree, then focuses.

## Risks

`select-pane` lifting a zoom is tmux behaviour, checked on 3.6a. A merge offer gets no Show agent, because the branch, not the agent, is what it asks about.

## Alternatives considered

Moving the offer to the inspector row while the agent is out of view: the row inserts above the terminal, which resizes it and reflows every pane, the one thing the bar exists to avoid. Hiding the offer: the agent can wait for hours, with only the card marker left.
