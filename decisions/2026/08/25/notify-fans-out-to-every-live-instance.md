# `dev3 notify` fans out to every live instance; `--desktop` does not

## Context

More than one dev3 process can share `~/.dev3.0`: the primary app plus a guest for
every task dev-server or `dev3 remote`. `discoverSocketIn` (`src/cli/context.ts`)
deliberately picks exactly ONE endpoint and prefers the primary over guests, because
routing a `devServer.stop` into the guest hosted by the session being stopped kills it
mid-request (#910/#920). A toast therefore appeared in one app only — the user was
looking at a browser served by a guest and never saw notifications sent from its own
task.

## Decision

`handleNotify` (`src/cli/commands/ui-control.ts`) sends `ui.notify` to the dialed
endpoint as before, then replays it to every other live endpoint via the new
`allLiveSocketPaths()` (`src/cli/context.ts`), best-effort and in parallel. Only the
primary's reply drives stdout and the exit code; a guest that refuses or dies is
ignored, and the extra count is reported (`Toast sent to 3 instances.`).

Within one process nothing changed — `index.ts` already broadcast every push to all
windows AND all connected browser clients.

`--desktop` stays single-target: Notification Center is one surface per machine, so
fanning out would fire duplicate OS notifications.

## Risks

Two instances that share a data dir now both raise a toast, so a future push carrying
per-instance state must not be added to this path. Discovery preference is untouched —
this is a fan-out on top of it, not a change to which instance "wins", so the
`devServer.*` routing invariant is intact.

## Alternatives considered

- **Change discovery to prefer the newest instance** — breaks the #910/#920 guarantee
  for every command, to fix one presentation path.
- **Fan out every `ui.*` command** (attention, show-image, show-artifact) — the badges
  and copied files are per-instance state, and duplicating them was not asked for.
- **Broadcast inside the app instead of the CLI** — the instances have no channel to
  each other; the sockets dir is the only shared registry, and the CLI already reads it.
