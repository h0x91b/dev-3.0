# The approval delay gets units without a new on-disk key, and the CLI asks before it waits

## Context

The agent-launch dialog approves itself after `GlobalSettings.agentLaunchAutoApproveMinutes`. The
setting was a fixed list of whole minutes (`0, 1, 2, 5, 10, 15`), so 15 seconds and 1 hour were
both unrepresentable.

## Investigation

Two things blocked simply widening the list.

`~/.dev3.0/settings.json` is shared with every other installed build, so a new key would be invisible
to them and the on-disk invariants forbid moving or renaming what is there.

And a longer delay did not work at all: `COMPLETION_APPROVAL_TIMEOUT_MS` and
`LAUNCH_APPROVAL_TIMEOUT_MS` in `src/cli/commands/task.ts` were both hard-coded to 10 minutes, so a
one-hour delay killed the waiting agent 50 minutes before the timer it was waiting on could fire.

A third problem surfaced in the dialog itself. Launch dialogs **queue** rather than stack
(`App.tsx`, `launchRequests`), but the bun-side timer started when the request arrived. A request
waiting behind another could therefore approve itself before a human ever saw it.

## Decision

The stored value stays `agentLaunchAutoApproveMinutes` and simply becomes **fractional**: 15 seconds
is `0.25`, one hour is `60`. An N-2 build reads `0.25`, computes `Math.round(0.25 * 60_000)` and gets
the same 15 000 ms — no new key, nothing renamed. The UI presents amount + unit
(`splitAutoApproveMinutes` / `autoApproveMinutesFrom` in `src/shared/types.ts`) and every value is
clamped into 5 s … 24 h, so a hand-edited file cannot park an agent for a week or fire before the
dialog paints. `0` keeps meaning "never", stored as the user's explicit choice; turning the delay off
and on again restores the amount rather than the built-in default.

The CLI learns the deadline instead of guessing it. A cheap `approval.policy` socket read
(`launchApprovalTimeoutMs`) runs before the blocking request and sizes the socket timeout to the
configured delay plus two minutes of grace; an app that cannot answer leaves the 10-minute baseline
in place rather than blocking the move.

`markAgentRequestShown` restarts the countdown the first time a client draws the dialog, and returns
the deadline it will actually fire on so the rendered countdown and the timer agree. Only the first
display re-arms it, so a reloading window cannot postpone a launch forever, and a request no client
ever draws keeps its original deadline — a closed window must not stall the requesting agent.

## Risks

A fractional value is invisible in an older build's fixed dropdown, which renders blank and would
overwrite the choice if the user touched it. The pre-flight adds one extra round trip to a launch
request. A 24-hour delay means a 24-hour socket timeout, which only matters for an app that hangs
without closing the connection.

## Alternatives considered

A new `agentLaunchAutoApproveMs` key — rejected, invisible to co-installed builds for no gain. A
"Never" entry inside the unit list — rejected, `0 hours` is not a sentence and "off" must stay a
stored choice rather than a magic number. Raising the CLI timeout constant to cover the longest
possible delay — rejected: it would block an agent for over an hour whenever the app hangs, while
the pre-flight costs one cheap read.
