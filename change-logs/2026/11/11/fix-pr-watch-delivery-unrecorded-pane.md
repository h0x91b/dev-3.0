Short: PR watch notices reach the agent

`dev3 pr watch` notices now reach the agent when the task's main pane id was never recorded or Claude runs behind a wrapper script. A Claude hook that reports its launch session id records the pane, the subscriber is found by its pane when the CLI's process ancestry does not reach the agent, and `dev3 pr watch` says when no subscriber could be identified.
