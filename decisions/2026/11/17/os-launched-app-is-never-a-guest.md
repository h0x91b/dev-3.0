# An app LaunchServices started is never a task's guest

## Context

A dev3 instance reads `DEV3_TASK_ID` at startup to decide whether it is a guest of a task: its socket sidecar records `hostTaskId`, CLI discovery ranks guests after primaries, and launch handoff and the self-hosted dev-server check read the same variable (see `dev-server-self-hosted-instance-socket-refusal.md`).

macOS `open` hands the caller's environment to the launched app. When an agent runs the install recipe's `open` step from its pane, the desktop app inherits that pane's `DEV3_TASK_ID` and registers as a guest of a task that may be long finished. Seen 2026-11-16: the installed app (sidecar `hostTaskId` = a completed task) and a dev-server instance started later were both guests, the newer socket won discovery, a `dev3 task move --status cancelled` from a third task opened its dialog in the dev window, and the request died with that window two minutes later. The CLI reported it correctly (exit 26, outcome unknown); the routing was wrong.

## Decision

At the top of desktop startup (`src/bun/index.ts`), `dropTaskEnvFromOsLaunch` (`src/bun/launch-origin.ts`) deletes the task-scoped pane env (`TASK_SCOPED_ENV_KEYS` plus `DEV3_DEV_SERVER` and `DEV3_WORKTREE_ROOT`) when `DEV3_TASK_ID` is set and LaunchServices started the process. It runs before any reader of `DEV3_TASK_ID`, so every guest check sees a primary.

The signal is the process tree: the bundle's launcher is a direct child of launchd, so the app process's grandparent is pid 1 (`ps -o ppid=`, which works from the hardened-runtime bundle). A dev build the devScript boots runs under `electrobun dev`, which spawns the launcher as its own child, so it keeps its env and stays a guest. Verified live both ways on a QA-scoped instance.

## Risks

- A dev-server guest whose `electrobun dev` parent exited has its launcher reparented to launchd, so a later check would read it as OS-launched. The check runs once at startup, while that parent is alive, so a running guest keeps its flag.
- macOS only. Linux and Windows keep today's behavior; a Linux desktop app started from a pane through a desktop launcher stays a guest.
- Headless `dev3 remote` (`headless-entry.ts`) is untouched: from an agent pane it is a real guest.

## Alternatives considered

- Keying on `DEV3_DEV_SERVER` alone would turn a dev build an agent starts with `bun run dev` from its pane into a primary that wins discovery by mtime, the same class of bug.
- Changing CLI discovery to prefer the older of two guests treats the symptom and still routes to a guest of a finished task.
- Never reading `DEV3_TASK_ID` from the environment would need a new launch-time signal for real guests from every launch path.
