# Terminal file-path links: the scope gate admits the OS temp directories

## Context

Cmd/Ctrl+Click file links in the terminal only resolve paths inside an allow-list (`allowedRoots` in `src/bun/rpc-handlers/terminal-paths.ts`), originally the home directory plus registered project roots — see `decisions/2026/08/06/terminal-file-path-links.md`. Agents routinely write screenshots and scratch output to `/tmp` (Codex prints them under "Viewed Image"), and those paths stayed plain text with no signal why.

## Investigation

The regex in `src/mainview/terminal-file-links.ts` matches `/tmp/x/y.png` fine; `statPathKind` returned `null` purely because `/tmp` is under neither root. On macOS `/tmp` is a symlink to `/private/tmp` and `os.tmpdir()` is `/var/folders/.../T`, so the same "temp" is three different string prefixes, and the gate is a string-prefix check that deliberately does not resolve symlinks.

## Decision

`tempRoots()` in `terminal-paths.ts` adds `os.tmpdir()` and `/tmp` to `allowedRoots`, each alongside its `realpathSync()` spelling, so `/private/tmp` and macOS's `/private/var/folders/.../T` count as the same place. A `TMPDIR` of `/` is dropped rather than trusted: `isUnder` would admit the whole filesystem through it.

Because the temp directories are world-writable, they are the one place the gate follows symlinks: `isPathAllowed()` accepts a path under a temp root only when `realpathSync()` of it also lands under an allowed root. Everywhere else the gate stays the pure string comparison the 2026-08-06 record chose. Covered by `src/bun/rpc-handlers/__tests__/terminal-paths.test.ts`, including a link that aims out of every root and one that aims back in.

## Risks

In remote mode an authenticated client can now preview any readable file under the temp directories, which is where agents write constantly — the same exposure class the home directory already carries. Files there are short-lived, so links are more likely than others to go stale within the 10s resolve cache.

The symlink check costs one `realpathSync` per temp-dir path and does not extend to home or project roots, so a symlink planted inside a project root still resolves to its target as it always has.

**Windows is unaffected by this change.** `isUnder` builds a `/`-separated prefix while `path.resolve` returns `\` paths there, so no path is ever under any root and the whole link feature — home and project roots included — is inert. That is a pre-existing limitation of the 2026-08-06 design, not something this record fixes; the temp-dir tests are skipped on `win32` rather than asserting a behaviour the platform does not have.

## Alternatives considered

Registering `/tmp` as a project (rejected: nonsensical on the board). Resolving symlinks for every root (rejected: widens the gate to every symlink target under `$HOME`, which the original record explicitly declined — the temp dirs earn the exception by being writable by other accounts). Whitelisting only image files under `/tmp` (rejected: agents also drop logs, diffs and reports there). Normalising separators in `isUnder` to make the feature work on Windows (rejected here: it changes behaviour for every root on a platform this change cannot validate, and belongs in its own record).
