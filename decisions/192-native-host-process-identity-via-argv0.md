# 192 — Native terminal host identity lives in argv0, not in the executable name

## Context

With several tasks running native terminals, a user looking at a system process
viewer saw a wall of identical `bun` / `dev3-terminal-host` rows and could not
tell which dev3 task owned which host or shell. Killing the wrong one loses work.

Hard constraints going in: no per-task copies of the carrier binary, no dynamic
renaming of packaged binaries, and no change to the macOS signing/package layout,
the Windows executable-image and Job Object contracts, process-tree cleanup,
reattach identity, or the host manifests.

## Investigation

Measured, not assumed — a probe process was spawned with an overridden `argv0`
off a carrier named `dev3-terminal-host`, then inspected from outside.

| Viewer / column | Carries per-task identity? | What it actually shows |
|---|---|---|
| macOS `ps -o comm=` | yes | `argv0`, verbatim and untruncated |
| macOS `ps -o args=`, `ps aux` COMMAND | yes | `argv0` + the rest of argv |
| macOS Activity Monitor, Process Name | **no** | the executable file's basename; it has no command-line column at all |
| macOS `ps -o ucomm=` | no | the 16-char kernel accounting name from the executable |
| Linux `ps -o args=`, `ps aux`, htop cmdline | yes | `/proc/<pid>/cmdline`, which starts with `argv0` |
| Linux `ps -o comm=`, htop/top name | no | `/proc/<pid>/comm`, set from the executable |
| Windows Task Manager → Details → Command line; Process Explorer | yes | `argv0` + args (libuv passes the exe as `lpApplicationName` and builds `lpCommandLine` from argv) |
| Windows Task Manager image-name column | no | `dev3-terminal-host.exe` — the existing contract, deliberately unchanged |

Two findings settled the mechanism:

- `node:child_process`'s `argv0` option works under Bun and does **not** disturb
  the child's own `process.argv`: it still sees the real `execPath` at `[0]`, the
  entrypoint at `[1]`, and the verb/session id at `[2..3]`. So the host's
  entrypoint assertion and verb parsing are untouched.
- `process.title` is not a usable carrier. Bun accepts the assignment on every
  platform, but where it lands is inconsistent, and on two of three it actively
  fights `argv0`. Measured by the visibility test on each runner:

  | Platform | `process.title` write | Effect |
  |---|---|---|
  | macOS | accepted | overwrites the argv area **in place**, bounded by the original `argv0` buffer — a probe named `dev3-terminal-host seq:1383 pane:1` had its identity replaced by the title, while an earlier probe with `argv0 = "bun"` saw the write silently do nothing |
  | Linux | accepted | sets `/proc/<pid>/comm`, truncated to 15 chars (`dev3-terminal-h`), and also rewrites cmdline |
  | Windows | accepted | reads/writes the **console title** (`before` came back as `Administrator: Windows PowerShell`), nothing to do with the process at all |

  A host that set its own title would be fighting its own name, so production code
  never writes it — the test only records the probe.

## Decision

The carrier is the detached host's **`argv0`**, formatted by one pure function.

- `src/bun/native-terminal-registry/process-naming.ts` — `nativeHostProcessName`
  produces `dev3-terminal-host seq:1383 pane:1`, falling back to the session id
  when no task number is in scope. Privacy is enforced here, not by callers:
  only a strictly pattern-matched task number (`\d{1,9}(-\d{1,3})?`) and the
  session id's own `pane-N` suffix may reach a world-visible string.
- Both launchers pass it — `defaultHostLauncher` (registry) and
  `nativeHostLauncher` (`native-host-runtime.ts`). The executable argument is
  unchanged, so nothing is copied or renamed.
- The number arrives through the task environment: `buildTaskLifecycleEnv` now
  exports `DEV3_TASK_SEQ`, which is already carried to the host inside the
  encoded shell launch spec. No new env contract, and no plumbing through the
  multipane coordinator.
- The host derives the same identity from the same two inputs and stores it in an
  **optional** `identity` field on the schemaVersion-1 session record. `parseRecord`
  is a whitelist, so a dev3 that predates the field reads such a record unchanged
  — additive, no migration, no version bump, nothing on disk moved or rewritten.
- Auxiliary panes (dev server, git operations) get the same treatment from one
  place: `openAuxPane` stamps `DEV3_TASK_SEQ` into the pane env for both backends,
  so every purpose's host is named without each call site remembering to, and a
  future purpose inherits it. A caller's own value wins.
- The **shell's** argv is left exactly as its launch spec defines it. Rewriting it
  would change `$0` and the leading-dash login-shell convention for the user's
  interactive shell. Shell ownership is instead readable from its parent host (the
  named process), the exported `DEV3_PANE_ID` / `DEV3_TASK_SEQ`, and diagnostics.
- `dev3 doctor --processes [--json]` is the documented fallback for the two
  columns that cannot show identity. It reads only the on-disk records, needs no
  running app, and prints task seq, logical pane, role, pid + parent, executable
  basename, and alive/stale/unknown. Never a title, prompt, path, token,
  endpoint, or raw command line — this output lands in bug reports.

## Risks

- The two negative columns stay negative. A user who only ever looks at Activity
  Monitor's Process Name still sees `dev3-terminal-host`; `--processes` and the
  help text are the mitigation.
- `argv0` contains spaces, so on Windows libuv quotes it in the command line.
  Display-only — nothing parses it, and the image name is passed separately.
- `ps -o args=` no longer begins with the executable path for these processes.
  The full path is still argv[1], and the record keeps `host.executable`.
- `DEV3_TASK_SEQ` / `DEV3_PANE_ID` are new ambient vars inside task panes.
  `configureTestIsolation` scrubs the whole injected task context so a suite run
  by an agent cannot silently read the agent's own task.

## Alternatives considered

- **Per-task copies or renames of the carrier** — the only way to reach macOS
  Activity Monitor's name column, and explicitly forbidden: it breaks signing,
  the packaged layout, and the Windows image-name contract.
- **`process.title`** — measured above; on macOS it destroys the argv0 it would
  be trying to complement, and its reach differs per platform. Recorded as
  evidence by the visibility test, never written in production code.
- **Extra trailing argv tokens instead of `argv0`** — visible in `ps -o args`
  and the Windows command line, but not in macOS `ps -o comm`, and buried at the
  end of a long line instead of leading it.
- **Rewriting the shell's `argv0`** — changes `$0` and login-shell detection for
  the user's own shell, and buys nothing on Linux, where `comm` ignores argv0.
- **Deriving seq in diagnostics by scanning `tasks.json`** — avoids the record
  field, but cannot answer for a stale record and duplicates project-slug
  resolution in the CLI.
