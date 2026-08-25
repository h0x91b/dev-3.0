# The setup-failure offer depends on whether the agent had already started

## Context

A `setupScript` that exits non-zero raised one modal card in the task pane:
"the agent was not started … Start agent anyway". That sentence is only true for
some launches, and the button behind it is destructive for the rest.

## Investigation

`buildSetupStartupWrapper` (`src/bun/rpc-handlers/shared-pure.ts`) emits the
agent's `tmux split-window` BEFORE the setup script in `parallel` mode and AFTER
it in `blocking` mode. `parallel` is the default for every project
(`src/bun/data.ts`), and native sessions ignore the mode entirely — they always
gate the agent behind setup. So in the common case the failure finds a live
agent, while the card claims the opposite and its primary button calls
`restartTask`, which destroys the whole session (`pty.destroySessionAwaited`)
and relaunches without setup: a working agent and its context, gone.

Three smaller faults with the same root: the card `autoFocus`ed that destructive
button, so a setup failing minutes into a session moved the keyboard out of the
terminal and turned the next Enter into a session kill; the only way to close it
was a button labelled "Show setup log" that showed nothing; and the dismissal
lived in component state, which `key={taskId}` (`TaskWorkspacePane.tsx`) throws
away on every task switch, so the popup came back.

## Decision

`launchTaskPty` records `Task.setupFailedAgentRunning` next to the exit code,
decided where the wrapper's shape is known (`!nativeBackend && mode ===
"parallel"`). `TaskTerminal` renders from it: a live agent gets a non-modal
strip with a re-run and a ✕, a never-started agent gets the dialog, with the
re-run leading and "start anyway" demoted to a fallback. Dismissing calls
`dismissSetupFailure`, which clears the verdict in the task, so it cannot return
in this component or a second viewer.

`rerunSetupScript` runs the setup script alone in an auxiliary pane
(`openAuxPane`, purpose `setupRerun`) and arms a fresh watch, so a second
failure raises the notice again. It is also a pinned row in the existing Scripts
dropdown — a rare recovery action belongs in an existing overflow, not in a new
always-visible button on the app's densest surface.

## Risks

`setupFailedAgentRunning` describes the launch, not the present: an agent that
has since exited still reads as running, and the strip then offers a re-run
where the dialog would have offered a restart. The task's restart affordances
are untouched, so that costs a click, not a recovery path.

## Alternatives considered

- **Keep one card, only fix the copy and confirm the destructive button.**
  Cheap, but the message stays vague in the case that matters most.
- **Count panes at render time instead of recording the launch.** Truth over a
  guess, but it needs a live tmux probe per viewer and still cannot tell the
  agent's pane from an auxiliary one.
- **Drop the overlay entirely for a strip in the task panel.** Cleanest, but it
  moves a surface and would leave a never-started agent with no visible way back
  to its prompt.
