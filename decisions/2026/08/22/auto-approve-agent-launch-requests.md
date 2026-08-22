# Auto-approve agent launch requests, never completion requests

## Context

An agent asking to set another task running (`dev3 task move --task seq:N --status in-progress`,
`dev3 task create --scratch --run`) blocks on the CLI socket while a modal waits for the user. If the
user is away, the requesting agent burns its whole client-side timeout and gets nothing — the launch
simply does not happen, even though the user would almost always have said yes.

## Decision

The launch request now carries a deadline and approves itself when it expires. Default 5 minutes,
`GlobalSettings.agentLaunchAutoApproveMinutes` (Settings → Tasks) changes it, `0` restores
answer-or-nothing.

- The timer lives in `createAgentRequest` (`src/bun/agent-requests.ts`), not in the dialog. The
  blocked CLI waits on that promise, so a closed window or a remote browser walking away must not be
  able to stall it. Firing goes through `resolveAgentRequest`, which already broadcasts
  `agentRequestResolved` and therefore closes every client's copy of the dialog.
- `AgentLaunchRequest.autoApproveAt` is a mirror for the countdown only.
- The dialog reports its agent/config/account pick through `updateAgentLaunchChoice`
  (`setAgentRequestLaunchChoice`), so a timeout launches with what the user last selected rather
  than the global default. Last writer wins across clients.
- **The completion dialog does not get this.** It destroys a worktree; silence is not consent to
  that.
- Duplicate launches are prevented by two pre-existing guards, deliberately reused rather than
  duplicated: the `launch:<taskId>` dedup key (a retry joins the pending request and inherits its
  original deadline instead of extending it), and the `isActivation` check in `task.move`, which
  never routes an already-active task into the dialog.

## Risks

A task can now start without anyone having looked at the dialog — that is the point, but it means a
misbehaving agent gets a launch every five minutes of user absence rather than none. The dedup key
and the activation guard bound this to one launch per task, and the setting turns it off entirely.
Wall-clock timers do not survive an app restart: a pending request dies with the process, exactly as
before.

## Alternatives considered

- **Timer in the renderer.** Simplest, and it has the user's pick in hand — but it dies with the
  window and would leave the agent blocked in precisely the "user walked away and closed the lid"
  case the feature exists for.
- **Renderer timer plus a bun backstop.** Two clocks, two answers to "which agent", one race.
  Rejected for a single authoritative timer with the choice mirrored into it.
- **Cancel the countdown as soon as the user touches the picker.** Attractive ("the human is here"),
  but it silently converts an auto-approving dialog into a blocking one, and the user asked for the
  opposite: their pick should ride along with the automatic launch.
