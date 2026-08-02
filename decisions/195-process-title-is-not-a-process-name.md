# 195 — `process.title` is not a process name under Bun; use `argv0`

## Context

Any time this repo wants a spawned process to be identifiable in a system process
viewer, `process.title = "..."` is the obvious first reach. It is the wrong one.
[Decision 192](192-native-host-process-identity-via-argv0.md) chose `argv0` for
native terminal hosts; this record exists separately because the finding applies
to **every** spawn in the codebase, not just that one.

## Investigation

Measured on all three supported platforms (seq 1383), by spawning a probe and
inspecting it from outside — never from what the process says about itself.

**Bun accepts the assignment on every platform and never throws**, so a smoke
test that only reads `process.title` back proves nothing at all. What actually
happens differs three ways:

| Platform | Where the write lands |
|---|---|
| macOS | overwrites the argv area **in place**, bounded by the length of the *original* `argv0` |
| Linux | sets `/proc/<pid>/comm`, truncated to 15 chars, and rewrites cmdline |
| Windows | sets the **console title** — reading it back returned `Administrator: Windows PowerShell`, nothing to do with the process |

The macOS bound is what makes this a trap rather than a limitation. A probe
spawned as plain `bun` (3 chars) silently ignored a longer title, which read as
"`process.title` is a no-op on macOS" — the wrong conclusion, drawn from one
shallow check. A probe spawned with a long `argv0` had that `argv0` **destroyed**
by the title write. Title and `argv0` share one buffer and fight over it.

## Decision

Production code does not write `process.title`. The carrier for process identity
is the `argv0` option of `node:child_process.spawn`, which under Bun does **not**
disturb the child's own `process.argv` — the child still sees the real
`execPath` at `[0]`, its script at `[1]`, and its own arguments at `[2..]`, so
argv-based verb and entrypoint parsing keeps working.

`argv0` reaches macOS `ps -o comm=` (verbatim, untruncated) and `ps -o args=`,
Linux `/proc/cmdline` (`ps -o args=`, htop), and the Windows Task Manager
Details → Command line column plus Process Explorer. libuv passes the executable
as `lpApplicationName` and builds `lpCommandLine` from argv, so the Windows
`.exe` image name is untouched.

Two viewers can **never** show anything but the executable basename, and no argv
trick changes that: macOS Activity Monitor's Process Name column (which has no
command-line column at all) and the Windows Task Manager image-name column.
Verified by screenshot — two identical processes off one carrier binary, one with
`argv0` overridden, render identically. The only lever there is per-task copies
or renames of the binary, which breaks signing, packaging, and the Windows
image-name contract. Ship a CLI fallback instead (`dev3 doctor --processes`).

The probe and the per-platform assertions, negatives included, live in
`src/bun/native-terminal-registry/__tests__/process-naming-visibility.test.ts`
and run on all three CI runners, so none of these facts can drift into a false
claim unnoticed.

## Risks

- The two basename-only viewers stay basename-only. Anyone who checks only
  Activity Monitor still needs the CLI fallback.
- The probe currently lives under the native-terminal-registry tests. A future
  non-terminal caller that wants process naming should reuse it rather than
  re-measure from scratch.

## Alternatives considered

- **`process.title` with a length-padded `argv0`** — reserving a long enough
  `argv0` would make the macOS write land, but the value still means three
  different things on three platforms, and on Windows it is the console title.
  Two mechanisms for one job, with the platform matrix doubled.
- **Per-task copies or renames of the executable** — the only way to reach the
  basename-only columns, and forbidden: signing, packaged layout, and the
  Windows image-name contract all key on that name.
- **Trusting the documented behaviour instead of measuring** — this is exactly
  how the "no-op on macOS" misreading happened. Every row of the table above
  comes from a live process inspected from outside.
