# `dev3 pr watch` is an opt-in subscription, not automatic PR notifications

## Context

Agents waited on a PR's CI or merge by polling `gh` or setting timers, which burns turns and tokens. dev3 already polls every task's PR, so it can tell the agent instead.

## Decision

An agent subscribes with `dev3 pr watch [--until ci|merged]`. The socket handler (`src/bun/cli-socket/pr-watch-commands.ts`) stores `Task.prWatches` and returns at once. `pollTaskPrStatus` (`src/bun/lifecycle/activities.ts`) hands each PR sample to `runPrWatches` (`src/bun/pr-watch-runner.ts`); the pure verdict is `evaluatePrWatches` in `src/bun/pr-watch.ts`. A fired watch sends one `<dev3-pr-status>` message through the held delivery of `sendMessageImmediately` (origin `dev3`) and is removed only after the message was accepted.

Opt-in because the cases differ: many agents open a PR and stop, and an automatic message would wake an idle agent, move its card and cost a turn for nothing. The subscription says what this agent waits for. State is persisted on the task so a restart of dev3 keeps it.

The message carries only dev3 text, the PR number and URL, a short SHA and the failed and total check counts, never a title, review, comment or check name: fork authors write those, and the text lands in the agent's prompt. The agent reads names with `gh pr checks`. A merge or close fires whatever the head. For CI, a sample whose head is an older ancestor of the watch's head is ignored, and any other head, even one this repository never fetched, moves the watch to it. A sample whose head is a strict ancestor of what a remote last had for the task's own branch (`refs/remotes/*/<branch>`, not the upstream, which is `origin/main` on a task branch) is skipped for CI; with no such ref nothing is skipped. The `ci` verdict is the same as the CI badge's: a rollup that does not yet list every external status can read as complete, so the message and help claim only that all checks GitHub listed finished.

The watched PR is the open PR of the task's own branch, which is what the poller samples; `--pr N` only has to match it, and a recorded PR that is no longer open is never a fallback. The message goes to the pane of the agent that subscribed, captured like a self-reminder's author (`scheduled-message-author.ts`). If that agent cannot be resolved (it is gone, or none was captured, which is always the case on Windows) the message goes to the task's only live agent pane, counted through the backend (`liveAgentPaneIds`: tmux, recorded panes that exist and run an agent; native, every live pane that runs an agent); with zero, several or unknown agent panes the watch waits and retries, and a sibling is never guessed. Every send names its pane explicitly, and subscribers landing on the same pane get one message. A watch is never deleted because its author is gone. A watched task is polled every 60 s in any project.

## Risks

An older dev3 that rewrites the task can drop the field, and the subscription then vanishes silently. A message held for delivery is lost if the app dies before the agent's pane goes quiet, as with `dev3 message`. An agent that never subscribes hears nothing, which is the intended default. After a failed delivery the task is retried only every five minutes. On Windows there is no process table, so only a lone coordinator pane counts as the agent; any task with more panes gets no message there (the author is never captured either). The PR is found by branch name only, as in the badge and merge detection, so a fork PR with the same branch name could be the one watched. A review task is not supported. A repository without CI checks never ends a `ci` watch, so the task keeps the 60 s poll until the PR is merged or closed; `--until merged` is the answer, and `dev3 pr watch --help` says so.

## Alternatives considered

Automatic notifications for every PR event were rejected for the noise above. A blocking `dev3 pr watch` that polls inside the CLI would hold the agent's turn and run a second poller beside the app's. Putting PR titles or review text in the message would have given forks a prompt-injection channel.
