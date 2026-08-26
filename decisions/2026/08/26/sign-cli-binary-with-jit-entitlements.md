# Sign the CLI binary with the JIT entitlements bun:ffi needs

## Context

`dev3 remote` (a headless server started by launchd) died every time the user
created a task, taking the browser/phone session with it — the page fell back to
"Reconnecting". The desktop app never reproduced it: identical code, identical
project, no crash.

## Investigation

The headless process's last log line was inside `clonePaths` (`src/bun/cow-clone.ts`)
and macOS recorded a crash report for it 7s later: `EXC_BREAKPOINT` / `SIGTRAP`,
`brk 1`, main thread, with `clonefile` resolved into a register and
`pthread_jit_write_protect_np` as the faulting frame.

`cow-clone.ts` reaches `clonefile(2)` through `bun:ffi`, and every `bun:ffi`
`dlopen` compiles a JIT trampoline. `scripts/sign-cli-binaries.sh` signed
`dist/dev3` with `--options runtime` and no entitlements: hardened runtime
without `com.apple.security.cs.allow-jit` refuses the JIT mapping, and the
process traps. The trap is a signal, not a JS throw — the `try/catch` inside
`tryClonefile` never sees it, so the whole server dies.

Two things hid this. The app's own bun binary is signed by Electrobun *with*
`allow-jit` + `allow-unsigned-executable-memory`, so the desktop path always
worked; and the local ad-hoc signature carried no hardened runtime at all, so a
dev machine never ran the configuration that ships.

Confirmed by A/B on the real `clonePaths` compiled and signed both ways:
hardened + no entitlements exits 133 (SIGTRAP) right after "Starting CoW clone";
hardened + both entitlements clones all three paths via `clonefile(2)` and exits
0. `allow-jit` alone is not enough — `dlopen` then succeeds but the first FFI
call is SIGKILLed, so both keys are required.

## Decision

`scripts/cli-entitlements.plist` carries the two entitlements, and
`scripts/sign-cli-binaries.sh` passes it via `--entitlements` for `dist/dev3` on
both the Developer ID and ad-hoc branches. The ad-hoc branch also gained
`--options runtime` so a local build is signed the way the release is — that
parity is what would have caught this before it shipped.

The fix is at the signing layer rather than in `cow-clone.ts`, for two reasons.

The app's own bun binary already ships with exactly these two entitlements
(Electrobun grants them), and it runs the same code. The headless server is the
same application without a window; granting the pair to one process and denying
it to the other is the inconsistency that produced the crash.

The alternative — deleting the FFI and letting `cp -cR` handle it — was measured,
not assumed: `clonefile(2)` clones this repo's `node_modules` in 3.1s, `cp -cR`
takes 14.8s. Roughly 12 extra seconds on every task creation.

Honest scope note: `cow-clone.ts` is the only FFI site currently *reachable* in
the headless binary. The others are latent, not live — `native-notifications.ts`
returns early on `DEV3_HEADLESS=1`, `hard-exit.ts` is called only from the GUI
entry, and `hideAppNative` is a no-op in the browser transport, so no remote
client can reach it. They would each become a crash the moment that changes,
which is an argument for fixing the binary rather than the call site, but it is
not the same as them being armed today.

Entitlements are scoped to `dist/dev3`; the bundled tmux and the bifrost sidecar
are not Bun and need no JIT.

A release gate in `release-build-macos.yml` guards both ways this can regress:
it asserts the CLI binary inside the built app still carries both keys (a
dropped flag, or a re-signing step stripping them), and it compiles the real
`clonePaths` into a probe, signs it with the same recipe, and runs a clone — so
an entitlement set that stops being sufficient (a bun upgrade wanting another
key) fails the build instead of shipping. Same reasoning as the Mach-O gate in
`decisions/2026/07/05/macho-headerpad-codesign-surgery.md`: this bug class is
invisible to signing, notarization, and green CI, so only executing the thing
catches it.

## Risks

Hardened runtime also enables library validation, so the CLI can only `dlopen`
Apple-signed or same-team libraries. Everything it opens today (`libSystem`,
`libobjc`, `kernel32` on Windows) qualifies. Opening a third-party dylib later
would additionally need `com.apple.security.cs.disable-library-validation`, the
way the app's bun binary already does.

Neither entitlement is a restricted one, so notarization is unaffected.

## Alternatives considered

Deleting the FFI and letting the existing `cp -cR` rung of the cascade do the
work. It removes the crash class outright, but only for `cow-clone` — the other
`dlopen` sites in the CLI binary would still trap — and it trades one atomic
whole-tree syscall for a per-file walk of `node_modules`.

Catching the failure in `tryClonefile`. Impossible: `SIGTRAP` is not catchable
from JS.
