# Route every CI install through the retry action, and refuse to retry `setup-bun`

## Context

`decisions/2026/08/22/retry-bun-install-on-a-registry-flake.md` built `.github/actions/bun-install/`
and wired it into `build.yml` only, closing its own risk list with "Only `build.yml` is covered.
Every other workflow still installs directly and can still hit this." Thirteen days later that
sentence cost a release: run 33849158300 (tag v1.51.2, 2026-09-04) died in
`windows-proof / posix-app-package (ubuntu-latest)` on `error: Fail extracting tarball for "mermaid"`,
in `windows-conpty-package.yml` — a workflow the action never reached. Five sibling jobs on the same
commit installed the same lockfile fine, `gh run rerun --failed` went green with no change, and all
five platform builds plus publish were skipped behind that one job.

## Investigation

Measured over the 30 days to 2026-09-04, across the 119 workflow runs GitHub still reports as failed
(118 logs readable): **6 runs — 5.1% — contain "Fail extracting tarball"**; zero contain
`IntegrityCheckFailed`. Only the first of the six (Build, 2026-08-22) predates the retry action.
The other five landed after it: Windows proof ×2, Canary publish ×2, Release ×1 — every one of them
in a workflow the action did not cover.

That 6 is a floor, not a total. `gh run list --status failure` cannot see a run that was rerun to
green: the run that motivated this task is itself absent from the sample, because it is on attempt 2.

The same 119 runs were scanned a second time for a failed `Setup Bun` step (a step name can only
appear in `--log-failed` if that step failed). **Zero hits.** `oven-sh/setup-bun` is not flaking here.

## Decision

Every `bun install` in `.github/workflows/` now goes through `./.github/actions/bun-install` — the
seven remaining direct call sites in `native-terminal-soak.yml`, `release-build-linux.yml`,
`release-build-macos.yml`, `release-build-windows.yml` and `windows-conpty-package.yml` (×3), each
keeping its existing `if:` guard, its own `actions/cache` restore where it had one, and its
`--frozen-lockfile` where it had one. Eleven call sites, no second way to install left in the repo.

`oven-sh/setup-bun` is deliberately **not** retried: nothing in 30 days justifies the extra moving
part, and the measurement above is the reason — revisit only if that count stops being zero.

`src/bun/__tests__/ci-bun-install-retry.test.ts` grew from guarding `build.yml` to guarding the whole
workflow directory: a bare `bun install` anywhere fails the suite, and any action call site that is
not frozen must be listed by name, so a new site defaults to needing `--frozen-lockfile` and
relaxing an existing one is a test failure rather than a silent change. Both guards were mutation
tested — a bare install put back into `windows-conpty-package.yml`, and `frozen-lockfile` dropped from
`native-terminal-soak.yml` — and each was caught.

## Risks

- **The retry's own bounds are unchanged and still apply.** Three attempts, 5s then 15s; a genuinely
  broken lockfile now fails ~35s later in seven more jobs than before.
- **The action runs `shell: bash` at call sites on `windows-latest`.** That is Git Bash on the runner,
  which every step here already relies on, but the Windows legs of `windows-conpty-package.yml` and
  `release-build-windows.yml` had never executed this particular script before.
- **The unfrozen allowlist is a literal list of file names.** Adding an install site to `build.yml`
  fails the suite until someone states which kind of install it is. That is the intent, not a defect.
- **The 5.1% is a floor.** Runs rerun to green are invisible to it, so the true rate is higher and
  cannot be recovered from the API after the fact.

## Alternatives considered

- **Leave the release workflows alone and rerun by hand.** This is what happened, and it is what
  skipped five platform builds behind one job; the rerun also erases the evidence, as above.
- **Retry `oven-sh/setup-bun` too.** Rejected on the measurement: zero failed `Setup Bun` steps in
  119 failed runs. Adding a retry there would be a wrapper with no observed failure to catch.
- **A third-party retry action (`nick-fields/retry`).** Rejected in the 2026-08-22 record and still
  rejected: a supply-chain dependency in every CI job for what 30 lines of bash does, and it cannot
  clear bun's install cache between attempts.
- **Assert a total count of call sites instead of an unfrozen allowlist.** A single number says
  nothing about which site changed, and it goes stale on every workflow edit without telling you why.
