# Local diagnostic logs

The Bun backend and CLI write daily diagnostic files under `~/.dev3.0/logs/YYYY/MM/YYYY-MM-DD.log`. These files are local troubleshooting data; they are not a task-history store and are not uploaded by the logger.

## Retention

The logger keeps the current day's file and the previous 13 calendar days (14 days total). On the first successful write of each day, it removes dated `.log` files older than that window. Missing, unreadable, or concurrently removed files do not interrupt application work.

## Payload policy

Log entries keep structural diagnostics such as event names, task and project IDs, counts, timings, exit codes, error messages, stacks, and command output. Prompt-bearing fields (`description`, `prompt`, `title`, and related nested values), URLs, credentials, environment values, and command arguments are replaced with redaction markers; recognized command fields retain only the executable name and argument count. New diagnostics should keep event messages static and put commands in `command`, `cmd`, or another recognized command field.

File writes, serialization, and retention cleanup are best-effort. A diagnostic failure must never change the success or failure of the operation being diagnosed.

## Local desktop freeze capture (macOS)

Set `export DEV3_DEBUG=1` in your login-shell profile (for example `~/.zshrc`) before the next normal launch of a build containing this feature. Desktop shell-environment import admits this one `DEV3_*` variable; other internal variables remain excluded. If shell-environment import is disabled, pass the variable directly to the app launcher. An explicit launcher value, including `DEV3_DEBUG=0`, wins over the shell profile. Merely exporting in a terminal does not change an already-running GUI process.

This switch is opt-in on every channel, including canary. It starts a macOS-only worker outside the host JavaScript loop. The daily app log confirms activation with `[freeze-diagnostics] Local freeze diagnostics enabled`. Without the switch there is no worker, process inspection, or stack sampling. The switch does not enable general debug logging or send anything to a telemetry service.

Records are under `~/.dev3.0/logs/freeze/` (or `DEV3_LOG_DIR/freeze`):

- `freeze-<timestamp>-<host-pid>.jsonl`: snapshots every 30 seconds and immediate suspected-stall records. Includes host/renderer heartbeat age, last visibility, native focus, viewport, sparse animation-frame age, terminal counts, artifact presence, and a bounded event history. A `.previous.jsonl` holds the preceding journal chunk.
- `freeze-<timestamp>-<host-pid>.<capture>-host.txt`: a three-second native host sample.
- `freeze-<timestamp>-<host-pid>.<capture>-renderer-<pid>.txt`: samples of attributed live WebContent/GPU processes when native logs identify them. The journal reports failed/skipped samples; absence of a renderer sample is not evidence that it was healthy.

The observer triggers on five seconds without host progress, ten seconds without a visible or natively focused window's heartbeat, or ten seconds without an animation-frame callback while visible. Its own scheduling gap gives a 20-second grace period and is explicitly recorded as **sleep or scheduling unknown**; the original timestamps are retained. Native focus can therefore expose a missing beat even when the renderer last reported hidden. A closed window is removed, and remote browser tabs are not registered.

Sampling is capped at three incidents per launch, at least five minutes apart. Each command has a deadline; each journal chunk/sample is limited to 2 MiB, and the collector retains five sessions (at most about 170 MiB). Remove the variable, or set it to `0`, before the next normal launch to disable collection. Startup failure, missing assets, and unavailable OS tools leave the app running.

These files stay local and may contain private paths from native stacks. They contain no intentionally collected terminal output, task text, document contents or environment dump. Review captures locally before choosing to share them. A suspected stall is not a causal verdict: a lost RPC channel, debugger pause or OS scheduling problem can trigger the same record. Native stacks may still contain unnamed JIT frames. No automatic restart or preference change is performed.

Verification uses a disposable process, never the user's running app:

```sh
bun src/bun/__tests__/freeze-diagnostics.bun-e2e.ts
```

The fixture copies the packaged worker resources into a temporary directory, blocks its own host loop for nine seconds, and requires a detection timestamp inside that interval plus a real native stack sample.
