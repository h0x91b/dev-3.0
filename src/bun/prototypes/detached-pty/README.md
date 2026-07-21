# Detached-PTY prototype (spike)

A narrow, self-contained tracer proving that a **detached Bun process can own a
single `Bun.Terminal` shell** while short-lived clients disconnect and later
reattach to the same live shell — **with no tmux involved**. Groundwork for the
tmux-removal roadmap (parent seq 1141).

This is a spike, NOT production terminal integration and NOT a `TerminalBackend`
abstraction. It is imported by nothing in the app (`src/bun/index.ts`) or CLI
(`src/cli/main.ts`) graph, touches neither `pty-server.ts` nor `src/bun/tmux/`,
and writes only to an additive, prototype-only metadata dir. Existing tmux-backed
terminal flows — including those of older dev3 versions on the same machine — are
completely unaffected.

## Roles

| File          | Role |
|---------------|------|
| `host.ts`     | Detached process that owns ONE `Bun.Terminal` shell and serves attach/input/output/resize/status/stop over the transport. |
| `launcher.ts` | `start()` spawns the host detached and waits for readiness, then returns without killing it; `stop()`/`status()` rediscover it from metadata. |
| `client.ts`   | Short-lived attach handle; `discover()` reconnects a fresh process from metadata alone. |
| `state.ts`    | Discovery metadata (`~/.dev3.0/pty-proto/state.json`, override via `DEV3_PTY_PROTO_DIR`). |
| `windows-job.ts` | Windows Job Object creation, self-enrolment, scoped force-stop, and handle queries. |
| `protocol.ts` | Wire protocol: binary frames = PTY bytes, text frames = JSON control. |
| `cli.ts`      | Manual driver + the `__host` re-entry the launcher spawns. |

## Design choices

- **Transport = WebSocket over loopback TCP (`127.0.0.1:0`) + per-run token.**
  Chosen over a Unix socket because it works on Windows and POSIX alike, and
  over raw TCP because WebSocket gives message framing for free (one socket, two
  channels). Mirrors the proven `pty-server.ts` / `dev3 remote` transports.
- **Detached lifecycle mirrors `dev3 remote --detach`:** the host writes a state
  file as its readiness signal; the launcher polls it, then exits; separate
  processes rediscover the host via that file.
- **Stop owns a process tree.** POSIX snapshots the root shell's PPID tree before
  signalling it. Windows creates a uniquely named Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, enrols the detached host before
  `Bun.spawn`, and lets the root shell plus descendants inherit that boundary.
- **Windows stop is graceful, bounded, then forceful.** The host sends Ctrl-C +
  `exit`, waits 1.5 seconds, removes only its token-matched metadata, then closes
  the Job Object handle. Kill-on-close terminates the host and every survivor.
  A disconnected launcher opens and terminates that same token-named job instead
  of trusting a possibly reused PID.

The Job Object bridge uses `bun:ffi` only inside this prototype and only on
Windows. The detached host self-enrolment removes the root-assignment race without
reimplementing Bun's ConPTY spawn in a helper. See
[`decisions/146-windows-job-object-containment.md`](../../../../decisions/146-windows-job-object-containment.md).
The minimum runtime contract lives outside this removable prototype in
`src/shared/native-terminal-runtime.ts`; both packaging and the tracer consume
that stable boundary.

## Try it

```bash
bun src/bun/prototypes/detached-pty/cli.ts start
bun src/bun/prototypes/detached-pty/cli.ts attach   # type; Ctrl-] to detach — shell keeps running
bun src/bun/prototypes/detached-pty/cli.ts attach   # reattach: same shell, state intact
bun src/bun/prototypes/detached-pty/cli.ts status
bun src/bun/prototypes/detached-pty/cli.ts stop
```

`stop` is idempotent: repeating it after cleanup prints `stopped` and exits 0.

## Packaged Windows ConPTY proof

The production Electrobun config pins `build.bunVersion` to 1.3.14. That setting
is global: macOS and Linux packages move to the same Bun version, while the
Windows `postBuild` proof inspects the actual `bun.exe` copied into the app tree
before Electrobun creates the self-extractor and updater payload.

The proof bundles `src/bun/native-terminal-host/main.ts`, then copies the
packaged runtime and entrypoint to a versioned temporary directory outside the
package. It renames the runtime to `dev3-terminal-host.exe`, removes Bun from
`PATH`, and invokes that staged executable by absolute path. The staged process
must re-enter itself detached, start absolute-path Windows PowerShell 5.1 through
raw `Bun.Terminal`, report distinct host and shell PIDs, and stop cleanly.

The external, renamed executable is part of the delivery contract. Electrobun
1.18.1's updater waits for every process named `bun.exe` or `Bun Helper` before
replacing the app, so a persistent host using the installed name would block an
in-app update. Future production discovery must stage under an additive,
immutable data path keyed by the host artifact/protocol and Bun versions, let an
older live host keep its files, and negotiate versions rather than adopting or
migrating it silently.

The isolated packaging fixture exercises the same hooks without requiring the
rest of the Windows app to be release-ready:

```powershell
Push-Location scripts/fixtures/windows-conpty-package
bun ../../../node_modules/electrobun/bin/electrobun.cjs build --env=canary
Pop-Location
```

Expected build output includes a JSON line with
`"marker":"DEV3_PACKAGED_DETACHED_HOST_OK"`, both actual Bun versions, package
and staged paths plus hashes, distinct positive host/PowerShell PIDs, and
`"systemBunOnPath":false`. The canary installer and updater payload are left
under `scripts/fixtures/windows-conpty-package/artifacts/`; the `Windows ConPTY
package` workflow runs this exact proof on native Windows. See
[decision 150](../../../../decisions/150-package-conpty-capable-bun.md).

This is deliberately a raw-PTY package proof. It does not feed terminal bytes
through ghostty-web or claim renderer readiness; Bun 1.3.14 has a separate
Windows callback/parser failure where ghostty-web can return a negative WASM
allocation pointer. The proof reports whether `bun:ffi` is importable, showing
that the carrier can support the prototype's Job Object bridge, but production
containment may still use a signed native helper.

## Native Windows PowerShell reproduction

Use native Windows PowerShell 5.1 or `pwsh` with Bun **1.3.14 or newer**, from
the repository root:

```powershell
$cli = "src/bun/prototypes/detached-pty/cli.ts"
$run = Join-Path $env:TEMP ("dev3-pty-job-" + [guid]::NewGuid())
$env:DEV3_PTY_PROTO_DIR = Join-Path $run "meta"
$env:DEV3_PTY_EVIDENCE_DIR = Join-Path $run "evidence"
$env:DEV3_PTY_PROTO_CMD = '["powershell.exe","-NoLogo","-NoProfile"]'
New-Item -ItemType Directory -Path $env:DEV3_PTY_EVIDENCE_DIR | Out-Null

bun --version
bun $cli start
bun $cli attach
```

At the first attached prompt, enter these lines, then press **Ctrl-]**:

```powershell
$env:DEV3_REATTACH_TEST = "works"
Write-Output "ROOTPID[$PID]"
```

Back at the outer prompt, reconnect and create a nested child plus grandchild:

```powershell
bun $cli status
bun $cli attach
```

At the second attached prompt, enter:

```powershell
Write-Output "REATTACHED[$PID][$env:DEV3_REATTACH_TEST]"
powershell.exe -NoLogo -NoProfile
Set-Content (Join-Path $env:DEV3_PTY_EVIDENCE_DIR "child.pid") $PID
Write-Output "CHILDPID[$PID]"
$grand = Start-Process -PassThru powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 300')
Set-Content (Join-Path $env:DEV3_PTY_EVIDENCE_DIR "grandchild.pid") $grand.Id
Write-Output "GRANDCHILDPID[$($grand.Id)]"
```

Press **Ctrl-]** again, then prove teardown from the outer prompt:

```powershell
$state = Get-Content (Join-Path $env:DEV3_PTY_PROTO_DIR "state.json") | ConvertFrom-Json
$childPid = [int](Get-Content (Join-Path $env:DEV3_PTY_EVIDENCE_DIR "child.pid"))
$grandchildPid = [int](Get-Content (Join-Path $env:DEV3_PTY_EVIDENCE_DIR "grandchild.pid"))
$ownedPids = @([int]$state.hostPid, [int]$state.shellPid, $childPid, $grandchildPid)
Get-Process -Id $ownedPids

bun $cli stop
bun $cli stop
bun $cli status
Get-Process -Id $ownedPids -ErrorAction SilentlyContinue

$tcp = [Net.Sockets.TcpClient]::new()
try { $tcp.Connect("127.0.0.1", [int]$state.port); $listenerOpen = $true } catch { $listenerOpen = $false } finally { $tcp.Dispose() }
$listenerOpen
Test-Path $env:DEV3_PTY_PROTO_DIR
```

Expected output:

- `bun --version` is `1.3.14` or newer; `start` prints distinct positive
  `hostPid`/`shellPid` values and a loopback endpoint.
- `status` reports those same PIDs with `alive=true`; `REATTACHED[...]` repeats
  the original root PID and ends in `[works]`.
- The first `Get-Process` lists all four owned PIDs. The first and repeated stops
  both print `stopped`; status prints `not running`; the second `Get-Process`
  prints no rows.
- `$listenerOpen` and `Test-Path ...\meta` both print `False`.

## Tests

- `bun run test:proto-e2e` — real-runtime regression on Windows and POSIX. It
  proves start → reconnect → child + grandchild → stop, ownership isolation,
  endpoint/handle/metadata cleanup, idempotence, and no tmux invocation. Windows
  probes retry harmless commands while each PowerShell prompt starts. Expected
  final line: `ALL CHECKS PASSED`.
- `__tests__/command-roundtrip.test.ts`, `__tests__/protocol.test.ts`,
  `__tests__/state.test.ts`, and `__tests__/windows-job.test.ts` — vitest units
  for startup command round trips, pure protocol/state logic, and the Win32
  handle lifecycle; part of `bun run test`.
