# Desktop startup stuck on Connecting

## Verdict

The September 12 incident is localized to backend startup while restoring the Codex terminal. Two failed desktop processes stop logging immediately after Claude trust completes and before Codex trust completes. The leading suspect is the unbounded synchronous `codex --version` probe inside `ensureCodexTrust`, but the incident's exact blocking instruction is unconfirmed: both failed processes had exited before investigation. No application fix has been applied.

## Evidence

Reviewed the daily application log for 13:35–14:35 local time (Asia/Jerusalem, UTC+3), plus the successful restart immediately afterwards. Source: the installation's `logs/2026/09/2026-09-12.log`. Raw logs and user configuration are intentionally not copied into this repository.

| Local time | Process | Observation |
| --- | --- | --- |
| 13:39–14:30 | 14421 | Older instance reports 19 event-loop stalls totaling 142,051 ms; longest 32,633 ms. These belong to a different process and cannot establish the later failures' cause. |
| 14:32:58 | 87757 | Desktop process starts. |
| 14:33:03.111 | 87757 | `getPtyUrl` starts restoring the previously selected Codex task. |
| 14:33:03.209 | 87757 | Last process log: `claude trust ensured`. No Codex trust completion or PTY creation follows. |
| 14:33:39 | 88802 | Next desktop process starts. |
| 14:33:41.499 | 88802 | The same task's `getPtyUrl` starts restoration. |
| 14:33:41.585 | 88802 | Last process log: `claude trust ensured`, again. |
| 14:33:47 / 14:34:00 | screenshots | First, populated task navigation with Connecting in the terminal; then task navigation also remains loading. |
| 14:35:28.419–.434 | 89950 | Successful restart crosses Claude → Codex trust in 15 ms. |
| 14:35:28.518 | 89950 | PTY creation completes. |

Both failed processes successfully answered project/task/settings RPCs before the cutoff. Their logs stop across all categories, consistent with a blocked backend rather than an isolated terminal WebSocket failure. A backend crash or another concurrent blocking operation cannot be excluded using this log alone. The available Bun crash report is from 12:33, outside this incident, with a different PID.

An unrelated stale-worktree cleanup error occurs in the successful restart too; it is not sufficient to explain the freeze.

## Checks performed

- Ran the installed `codex --version` 15 times with an external three-second timeout. All returned `codex-cli 0.154.0` in 9–20 ms.
- Read the current main Codex config and ran its parser and `ensureCodexConfig` 100 times without writing it. Total: 156 ms; no stall. This does not establish what the files contained during the incident.
- Invoked the actual `detectCodexVersion` with a temporary PATH fixture named `codex` that sleeps two seconds before printing a version. A 20 ms heartbeat registered **zero ticks over 2,245 ms**. The assertion requiring responsiveness failed (exit 1). This proves a slow child can produce whole-backend unresponsiveness, not that the real child hung during the incident.
- Confirmed failed PIDs 87757 and 88802 were no longer running. Their stacks cannot be recovered retrospectively.

## Relevant code

- `src/bun/rpc-handlers/tmux-pty.ts`: `launchTaskPty` awaits Claude trust, then Codex trust, before PTY creation.
- `src/bun/agents.ts`: `ensureCodexTrust` resolves the path, reads/parses the main config, calls `getCodexVersionCached`, patches config and profile files.
- `src/bun/codex-config.ts`: `detectCodexVersion` calls synchronous `spawnSync(["codex", "--version"])` without a timeout. Startup config installation probes independently, so its successful earlier probe does not populate `agents.ts`'s cache.
- `src/bun/spawn.ts`: slow-spawn logging happens only after the synchronous call returns.
- `src/bun/loop-monitor.ts`: the stall monitor uses `setInterval` on the blocked event loop and therefore also reports only after recovery.

## Next capture and repair scope

During the next freeze, leave the application running and capture the backend before restarting it. In a separate terminal, identify the desktop backend (`./bun` whose parent is the desktop launcher):

```sh
ps -axo pid,ppid,state,etime,pcpu,comm
```

Then replace `BACKEND_PID` below with that numeric PID:

```sh
sample BACKEND_PID 5 -file /tmp/dev3-connecting-sample.txt
ps -axo pid,ppid,state,etime,pcpu,comm > /tmp/dev3-connecting-processes.txt
```

The sample distinguishes a child-process wait from parsing, filesystem I/O, and unrelated synchronous work. These files are local diagnostics and should be reviewed before public sharing.

The justified hardening direction is to move external Codex capability/version probes off the main event loop, bound their duration, drain child output concurrently, and share the probe result across startup and launch. A regression test should verify that a deliberately nonresponsive binary cannot stop unrelated RPC work and cannot leave restoration pending forever. Merely catching exceptions or caching the first synchronous call leaves the first-launch failure intact. File-stage timings would improve attribution, but timers within the backend cannot diagnose a permanently blocked backend by themselves.
