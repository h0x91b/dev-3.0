# 078 — CLI commands for driving the app UI (notify / attention / ui state)

## Context

The `dev3` CLI could mutate task data but had no way to grab the user's attention through the app UI. Agents had only the terminal bell (a side effect of emitting BEL), which is a count with no message and no click target.

## Decision

Added three CLI verbs, routed through the existing CLI Unix-socket handler map in `src/bun/cli-socket-server.ts` (which shares the bun process with the renderer, so it can push to windows):

- `dev3 notify "msg" [--level] [--desktop]` → handler `ui.notify`. In-app mode pushes a new `cliToast` event (`src/shared/types.ts`); the renderer (`App.tsx` → `toast.tsx`) shows a clickable toast that navigates to the task. `--desktop` calls the new `notifyFromCliDesktop` in `rpc-handlers/shared.ts`, reusing the watched-task focus-proxy (`lastWatchedNotification` + `openTaskFromNotification`) for click-to-open.
- `dev3 attention "reason"` → handler `ui.attention`, pushes new `cliAttention`. Reducer `addBell` now carries an optional `reason` stored in a new `bellReasons` map (`state.ts`); `TaskCard`/`ActiveTasksSidebar` show it as the badge tooltip.
- `dev3 ui state` → handler `ui.state`, returns `isAppForeground()` + `getActiveContext()` so an agent can skip pinging when the user is already on the task.

The dev3 agent skill (`agent-skills.ts`) documents all three so agents discover them.

## Risks

`ui.state` only knows the focused task/project + foreground (reported by the renderer); it cannot distinguish split vs fullscreen. Click-to-open for `--desktop` relies on the same best-effort focus proxy as watched-task notifications (Electrobun has no notification click callback), so a notification clicked outside the 3s TTL won't navigate.

## Alternatives considered

- Reusing the `terminalBell` push for attention — rejected: it has no reason field and conflates agent intent with terminal noise.
- A bun→renderer request to read live UI state per call — rejected: the renderer already reports active context to bun, so a cached read is simpler and synchronous.
