# One-click reopen goes to Agent is Working

## Context

A completed or cancelled task could only be reopened through the status pill in its details dialog. The pill opens a "Reopen as" menu, but it reads as a label, so users did not find it. Open task on a closed card showed a screen whose only button was Back to Kanban.

## Decision

The details dialog of a closed task and the closed-task screen each get a Reopen task button. Both call `moveTaskToStatus` with `in-progress`, the same path as the "Reopen as" menu, so worktree, shared-folder and virtual projects behave as they already do there. The lifecycle prepares the task again and the agent resumes its saved conversation.

The closed-task screen stays up, with the button disabled, until the server reports the preparation or the move settles. The optimistic `in-progress` snapshot has no workspace yet, and a session read in that window would classify the pane as a broken environment and offer Complete and Cancel.

## Alternatives considered

- To Do: `moveTaskToStatus` treats To Do on a task with a run as a reset, which discards the worktree and the conversation.
- The column the task left (for example Your Review): the agent is running again after a reopen, and the status hooks move the card on from Agent is Working as soon as the agent stops.
- Navigating away from the closed screen after the click: the user opened this task to work on it, so the terminal attaches in place.
