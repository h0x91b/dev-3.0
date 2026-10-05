# Sleep inhibit renews with an overlap instead of lapsing hourly

## Context

`caffeinate.ts` runs `caffeinate -s -t 3600` (or `systemd-inhibit … sleep 3600`) and relied on the 10-second
resource-monitor poll to respawn it after the 1-hour safety timeout. A user reported the Mac sleeping while
agents sat idle waiting for scheduled messages, even though the setting was on.

## Investigation

The macOS power log (`pmset -g log`) showed three of the four recent true `Idle Sleep` events on AC power
landing in the exact second the dev3 inhibit process reached its 3600 s timeout, before the poll respawned
it. A released assertion lets an idle machine sleep at once, so the up-to-10 s gap was enough. While an agent
works, Claude Code holds its own `caffeinate -i -t 300`, which covered the gap — hence "it only sleeps when
agents are idle". The keep-awake policy itself never depended on agent activity or pending timers.

## Decision

`startInhibit()` arms a timer (`armRenewal`) that fires 5 minutes before the safety timeout; `handOver()`
spawns the successor first and only then kills the old process. If the successor fails to start, the old
process is kept. The renewal does not depend on the resource-monitor poll. The policy (setting OR remote
access) is unchanged, so pending scheduled messages, deferred launches and automations are covered because
the app keeps the machine awake for its whole run.

## Risks

`setTimeout` and the inhibit process's own timer must agree on whether host sleep counts; both use clocks
that pause during sleep, and the 5-minute lead absorbs drift. If the old process exits first anyway, the
poll still respawns it as before.

## Alternatives considered

- `caffeinate -w <pid>` with no timeout: no renewal needed on macOS, but Linux has no equivalent flag and the
  two backends would diverge.
- Adding pending timers to the keep-awake condition: a no-op while the setting is on (already always-on), and
  it must not override an explicit user disable.
- Adding `-i` so battery idle sleep is also blocked: `-s` only holds on AC power, but changing battery
  behaviour is a user decision, left open.
