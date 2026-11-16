# The completion bar follows the agent's pane id

## Context

The inline completion bar (`completion-offer-style-setting`) took the pane with the lowest layout index as the agent's. A swap moves the agent anywhere, so the bar then sat over a shell. A zoom on any pane sent the bar to the whole terminal, over the zoomed shell, while the agent's prompt was not visible at all.

## Decision

`TaskPaneState.agentPaneId` names the main agent's pane. Both backends fill it through `mainAgentPaneId` (`src/bun/agent-message-target.ts`), the same rule that routes task-addressed messages: on tmux the first `sessionState` entry, else the first listed pane; on native `pane-1`. `agentPanePlacement` (`TaskCompletionStrip.tsx`) frames that pane. When the agent's pane is zoomed, or is the only pane, the bar uses the whole terminal. When another pane is zoomed, the overlay stops hosting the offer, and the inspector's inline row asks instead. If the agent's pane is unknown, the bar also uses the whole terminal.

## Risks

A tmux agent pane in a window that is not active is not among the listed panes, so the bar uses the whole terminal of the active window. The inspector row appears and disappears as the user zooms, which shifts the inspector by one row.

## Alternatives considered

Hiding the offer while the agent is zoomed out: the agent can wait for hours, and only the card marker would show the ask. Keeping the bar over the zoomed pane: that is the defect this record fixes.
