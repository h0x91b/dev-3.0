Short: PR watch notices reach the agent

`dev3 pr watch` notices now reach the agent when the task's main pane id was never recorded or Claude runs behind a wrapper script. A Claude hook that reports its launch session id records the pane, and the sending agent is found by its pane when the CLI's process ancestry does not reach it, which also applies to `dev3 message` replies and self-reminders. `dev3 pr watch` says when no subscriber could be identified.
