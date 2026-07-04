# 104 — Process-scanning primitives must be async (spawnSync bans in pollers)

## Context

The UI froze for seconds whenever the user switched tasks: terminals hung on
"Connecting...", git header actions appeared stuck. The in-app loop-monitor
(`src/bun/loop-monitor.ts`) logs `Event loop stall detected`; log analysis
showed stalls jumped ~10x in mid-June 2026 (June 23: 7392 stalls totaling
~91 minutes) and a 14.7s stall exactly matched a terminal whose WebSocket
upgrade could not be processed until the loop unblocked.

## Investigation

Attribution method: a stall's block STARTS at `logTime - stallMs`; the last log
line before that moment names the culprit. Top offenders were the port-scanner
and resource-monitor pollers: every 10s they ran `lsof -i`, `ps -eo`, and TWO
`tmux list-panes` per session — all `Bun.spawnSync` on the main loop. With 30+
sessions that is 100+ synchronous forks per cycle; under system load (parallel
agents compiling/testing) each fork slows 10–100x. Also found: `ensureCodexTrust`
spawned an uncached `codex --version` on every task launch, and `buildDevServerStatus`
called sync `getLsofOutput`. Caveat learned: CLI/test processes append to the
same daily log file, so log lines now carry a PID to keep attribution honest.

## Decision

All primitives in `src/bun/port-scanner.ts` (`collectProcessInfo`,
`getSessionPanePids`, `getLsofOutput`, `buildProcessTree`, `collectTaskPids`,
`scanTaskPorts`, `findPortHolders`) and `getPidCwd` in `process-reaper.ts` are
async (`Bun.spawn` + drain stdout concurrently with `exited`). Pollers batch
tmux into one `list-panes -a -F '#{session_name}\t#{pane_pid}'` per cycle
(`getAllSessionPanePids`). `codex --version` is cached for the process lifetime
(`getCodexVersionCached` in `agents.ts`). `spawnSync` in `spawn.ts` logs any
call taking ≥250ms with its argv.

## Risks

`collectProcessInfo` caches the promise — a failed `ps` is cached for 5s (same
as before, but now shared by concurrent callers). Poller cycles overlap in
theory if a cycle exceeds 10s; each cycle reschedules only in `finally`, so no
unbounded pileup. Mock-based tests must route spawn stubs by argv, not by call
order — internal scan ordering is not a contract.

## Alternatives considered

Worker-thread pollers (keep sync code off the main loop): heavier, and RPC
handlers still needed the same primitives async. Load-based poll throttling:
treats the symptom, freezes would persist at exactly the times the user is
most active. Rejected both in favor of removing the blocking calls outright.
