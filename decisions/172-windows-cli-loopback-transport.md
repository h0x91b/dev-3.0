# 172 — Windows CLI transport: loopback TCP behind a file-path endpoint handle

## Context

The app serves CLI requests over a Unix-domain socket (`Bun.listen({ unix })` in
`cli-listener.ts`, discovered from `~/.dev3.0/sockets/<pid>.sock` by
`src/cli/context.ts`). Windows has no such socket to bind, so the bundled
`dev3.exe` had no way to reach the running desktop app. Seq 1296 needed a local
transport without adding an auth framework, a remote listener, or a second
command API.

## Investigation

`socketPath` is threaded as a plain `string` through ~220 references in 41 files
(every `src/cli/commands/*.ts` handler signature, `remote-state.ts` persisted
state, `doctor.ts` deps). Turning it into a typed union would have been a 41-file
refactor and would have made "POSIX behavior is unchanged" much harder to prove.

Bun's full documentation (`llms-full.txt`) never mentions Windows named pipes or
`\\.\pipe\`; `unix:` is documented only for POSIX sockets plus the Linux abstract
namespace. Named pipes were therefore rejected as an undocumented foundation.

`src/bun/instance-broadcast.ts` is a **second** client of the same transport
(app→app `_notify` fan-out). Porting only the CLI client would have silently
killed cross-instance notifications on Windows.

## Decision

Keep the endpoint handle a **real file path** and give Windows a second carrier:

- The app binds `Bun.listen({ hostname: "127.0.0.1", port: 0 })` and publishes
  `~/.dev3.0/sockets/<pid>.endpoint.json` (`src/shared/cli-endpoint.ts`,
  `startCliListener` in `src/bun/cli-listener.ts`). That record's path *is* the
  handle, so `existsSync`, `doctor` output, and `remote-state` persistence keep
  working untouched, and `.sock` handles stay byte-for-byte what they were.
- Both carriers share one `createSocketHandlers`, so framing, the 1 MB bound,
  malformed-line handling, and backpressure cannot drift between platforms.
- The record carries a random 32-byte `token`. A loopback port has none of a
  socket file's access control, and a stale record's port can be taken over by an
  unrelated process; `CliRequest.token` is set only on the loopback carrier and
  compared with one string equality. A mismatch surfaces as `StaleEndpointError`
  → the documented `CLI_EXIT_CODE_APP_NOT_RUNNING` (2) with retry advice, never
  as a command failure. This is the same shape as the native terminal host's
  existing token check (decision 105 era, HOST-002) — not an authorization system.
- `parseCliEndpointRecord` rejects any non-loopback `host`, so a tampered or
  corrupted record cannot make the CLI dial a LAN address.
- Discovery (`describeEndpointEntry` in `src/cli/context.ts`) treats records by
  the same rules as sockets: primary before guest, then Unix before loopback,
  then newest mtime, then highest pid; dead-pid and unparseable records are
  dropped so they cannot block a healthy instance.
- `ensureDev3Cli` copies (never symlinks) `dev3.exe` on Windows, since creating a
  symlink there needs Developer Mode or elevation, and `index.ts` installs the
  platform-suffixed bundle name.

## Risks

- A same-user local process that can read the record can issue CLI commands. That
  is the same trust boundary as the POSIX socket file, and the token stops
  everything that cannot read the user's profile.
- A stale record whose port is squatted by a *non-dev3* process yields the
  existing "Invalid JSON response" / empty-response failures rather than the
  token path. Both still exit 2 with actionable text.
- The endpoint record is additive: every pre-existing scan filters on `.sock`, so
  older installed versions ignore it (the `~/.dev3.0` N-2 invariant holds). No
  file is renamed, moved, or migrated.
- The Windows end-to-end proof through the *packaged* `dev3.exe` is automated by
  `bun run test:cli-packaged-e2e` (compiles the CLI with `bun build --compile`
  and drives the binary against real loopback listeners in a temp state dir; it
  runs on the Windows CI matrix, where the artifact is `dev3.exe`). What remains
  human-only is the real desktop app publishing the record on Windows.
- Both `src/bun/paths.ts` and `src/cli/context.ts` resolve the state root from
  `process.env.HOME || "/tmp"`. Windows normally leaves `HOME` unset, so app and
  CLI agree but on a non-`USERPROFILE` path. That is Seq 1295's contract, not
  this change's; the packaged E2E injects `HOME` explicitly.
- The packaged CLI resolves context from `cwd` before the `DEV3_TASK_ID` env var,
  so a harness run from inside this repo's worktree dials the *real* running app.
  The E2E runs the child with `cwd` set to its temp state root.

## Alternatives considered

1. **Typed `Endpoint` union instead of a path handle** — cleaner types, but a
   41-file churn that would have obscured the POSIX-unchanged guarantee.
2. **Windows named pipe via `Bun.listen({ unix })`** — no port and OS-level ACLs,
   but undocumented in Bun; kept as the fallback if loopback ever proves
   unavailable in the packaged runtime.
3. **Extend `<pid>.meta.json` instead of a new record** — older builds parse that
   sidecar, so adding transport fields risked confusing them; a new suffix they
   already skip is strictly safer.
4. **No token, loopback only** — matches the task's literal "no auth" constraint
   but leaves the port open to every local process and cannot distinguish a live
   instance from a stale record on a reused port.
