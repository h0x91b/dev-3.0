# A failed Windows build fails the whole release

## Context

`windows-zip-on-the-release-page.md` shipped the Windows leg of `release.yml` as best-effort:
`build-win-x64` was called with `bestEffort: true`, `release-build-windows.yml` turned that into a
job-level `continue-on-error`, and a `Warn when the Windows build is missing` step in the `release`
job left an annotation when no zip arrived. The result is a stable release that ships without
Windows while every job is green, and the only evidence is a workflow annotation nobody reads.

Arseny was shown that behaviour in one sentence ("если Windows сломается, релиз всё равно выйдет")
and answered: **"делай и запускай таск - теперь надо фейлить всё…"**. Windows is a first-class
platform from here on.

## Decision

Windows is fail-closed on every channel, and the tolerance is removed at the root rather than
pinned to `false` at the call sites.

- `release.yml` → `build-win-x64` no longer passes `bestEffort`. A failed Windows build fails the
  job, which leaves the `release` job's `needs:` unsatisfied, so no GitHub Release is created —
  the macOS disk images included.
- `release-build-windows.yml` drops the `bestEffort` input and its `continue-on-error` entirely.
  Both callers would otherwise pass `false`, and an input every caller pins to `false` is an
  escape hatch waiting to be flipped back. `canary-publish.yml` drops the now-nonexistent input;
  its behaviour is unchanged, since `false` was GitHub's default spelled out.
- The `Warn when the Windows build is missing` step is **deleted, not re-scoped**. The `release`
  job cannot start unless `build-win-x64` succeeded, so a missing Windows zip is impossible by
  construction and the step is a branch that can never run. Re-scoping it to `linux-arm64` (still
  best-effort) was rejected as scope creep dressed as thrift: that platform's absence is already
  handled inline by the release-body and Homebrew-formula conditionals, and inventing a warning
  for it in this change would smuggle an unrequested behaviour into a mandate about Windows.
- The Linux legs are untouched: `linux-arm64` keeps `bestEffort: true` (its Electrobun GUI bundle
  is genuinely unproven), `linux-x64` keeps `false`. `release-build-linux.yml` keeps the input.
- `workflow-windows-release-asset.test.ts` now pins the **absence**: no `bestEffort` input, no
  `continue-on-error` in the Windows workflow, no `bestEffort` at either call site, no
  Windows-less-release warning step — plus a guard that the Linux legs kept their own semantics.

## Risks

The accepted cost is the one that bought best-effort in the first place. `build-win-x64` runs in
parallel with the macOS and Linux legs, so a Windows failure can land after those have already run
`aws s3 sync` to the bucket root that feeds the updater. That tag then has a published update and
no GitHub Release — a partial ship. The remedy is re-running the run, not tolerating the failure;
that is exactly the trade Arseny made. Making the failure impossible instead of merely fatal would
mean serialising the ~35-minute Windows job in front of every publisher, which is a different
change.

## Alternatives considered

- **Keep the input, pass `false`.** Smallest diff, and leaves a one-word edit between here and the
  old behaviour with no test in the way. Rejected: "do not add an escape hatch."
- **Keep the warn step, re-scoped to Windows-still-possible states.** There are none.
- **Gate the publishers on `build-win-x64` the way they are gated on `windows-proof`.** Removes the
  partial-ship window, adds ~35 minutes of wall clock to every release before anything ships. Not
  what was asked for; recorded here as the follow-up if partial ships ever actually bite.
