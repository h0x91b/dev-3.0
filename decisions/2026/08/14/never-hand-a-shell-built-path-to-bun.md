# Never hand a shell-built absolute path to bun

## Context

`publish_version()` in `scripts/create-release-artifacts.sh` stamps the `+canary.<short-sha>`
suffix by importing `src/shared/update-channel.ts` inside `bun -e`. It addressed the module
with `$(cd "$(dirname "$0")/.." && pwd)/src/shared/update-channel.ts`. Green on macOS and
Linux for its whole life; the first `build-win-x64` job ever to execute it died there
(canary-publish run 31789301294, job 94733263647, sha 52729daea):

```
error: Cannot find module '/d/a/dev-3.0/dev-3.0/src/shared/update-channel.ts' from 'D:\a\dev-3.0\dev-3.0\[eval]'
```

## Investigation

`release-build-windows.yml` runs that step with `shell: bash`, which on a GitHub Windows
runner is Git Bash. Its `pwd` answers in MSYS (`/d/a/...`); bun is a native Windows binary and
resolves only `D:\a\...`. Same directory, two dialects — both printed in that one error line,
which is the fingerprint. Fail-closed held: step 14 (S3 upload) was skipped, nothing was
half-published, and the 73-byte `canary-win-x64-update.json` in the log is electrobun's own
manifest written minutes earlier, not a truncated one of ours.

## Decision

The subshell `cd`s to the repo root and imports **relative to the cwd** — no absolute path
crosses into bun at all. `cd` is bash's own and understands both dialects; the child inherits
a cwd already in the platform's native form; `bun -e` resolves `./…` against that cwd. One
code path on every platform.

The proof moved to where the bug lives: `src/bun/__tests__/create-release-artifacts-win-publish.test.ts`
runs the script's Case 1 end to end and is executed on **windows-latest** by
`windows-conpty-package.yml`, the job that gates every publisher. That file needs only bash,
bun and git, so it survives a Windows runner — unlike the sibling tests in
`create-release-artifacts.test.ts`, which stage `zig-zstd` shell shims named `.exe`.

## Risks

The Windows leg is proved only by CI; nothing here is verifiable on a developer's macOS box,
and a POSIX pass says nothing about it — that is the defect this record exists for. Write
"untested on Windows" rather than "holds".

## Alternatives considered

- `cygpath -w` before interpolating — Windows-only, needs a branch, and injects backslashes
  into a JS string literal.
- Compute the suffix in bash — duplicates `canaryDisplayVersion()`, whose inverse the app
  parses with; the round trip exists precisely so the two cannot drift.
- Run the step under `pwsh` — splits one script across two shells for a single line.
