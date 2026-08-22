# Retry `bun install` on a registry flake, loudly, instead of failing CI

## Context

`bun install` intermittently dies on one package with `error: Fail extracting tarball for "mermaid"`
and exits 1, taking the whole job with it. Observed twice within one hour on 2026-08-22 on two
unrelated pull requests — PR #1473 `test (1/5)` (job 97028286253) and PR #1472 `test (4/5)`
(job 97034859783). Neither PR touched `package.json` or `bun.lock`, and `mermaid` is a plain
dependency on `main`, so the failure was unreachable from either diff: it is infrastructure.
`mermaid` is simply the largest tarball, not the subject.

Cost is not only the rerun. A red shard trains everyone to assume flake and rerun, which is exactly
how a genuine regression gets rerun away. `build.yml` installs in four jobs, so the per-run chance is
several times the per-job chance.

## Investigation

Failure mode is a truncated or unextractable tarball, which is per-download, so a second download
usually succeeds. A failed extraction can also leave a partially written `node_modules` and a corrupt
entry in bun's install cache, so a naive retry may re-read the same bad bytes; both are removed
between attempts. `bun pm cache rm` needs a `package.json` in cwd, which every call site has.

## Decision

`.github/actions/bun-install/` — a composite action wrapping `install-with-retry.sh`: three attempts,
sleeping 5s then 15s, removing `node_modules` and clearing bun's cache after a failed attempt. Every
retry prints a `::warning` annotation and appends a line to `$GITHUB_STEP_SUMMARY`, and a total
failure prints `::error` — a silent retry would hide the registry's failure rate, which is worse than
the flake. Wired into all four install sites in `.github/workflows/build.yml`, with
`frozen-lockfile: "true"` preserving `terminal_e2e`'s stricter install.

Caching stays refused. The comment above the old install steps records the measurement: a cache hit
restored in 7s where `bun install` takes 5s, and the entries ate 4.8 GiB of the 10 GB repo cache the
Windows proof depends on. Nothing here disproves it, so it is carried into the action verbatim.

Proof is in `src/bun/__tests__/ci-bun-install-retry.test.ts`, which runs the real script against a
fake `bun` on `PATH` that fails a chosen number of attempts — the retry path executes for real
instead of waiting for a registry that only fails sometimes. Four mutants were run and all four were
caught: one attempt only, no `node_modules` wipe, no annotations/summary, and a bare `bun install`
sneaking back into `build.yml`.

## Risks

- **A retry cannot distinguish a flake from a real failure.** A broken lockfile, a wrong dependency,
  or an unreachable registry fails all three attempts and still fails the job — roughly 35s later
  (two extra installs plus 20s of sleep). Nothing in the output distinguishes the two cases up front;
  the attempt count in the log is the only signal, which is why it is announced.
- **The loud announcement is load-bearing, not a nicety.** The attempt count in the log is the ONLY
  thing that separates a registry blip from a real breakage after the fact. Quietening those warnings
  to reduce noise would destroy the only diagnostic this change leaves behind — do not remove them
  without replacing the signal.
- **The retry deliberately does not classify the error.** It retries any non-zero `bun install`
  instead of pattern-matching the message. The failure modes (a truncated tarball, a 500, DNS) share
  no text, and a pattern that misses one turns a flake into a flake that is no longer retried.
  Retry-anything with a hard cap plus a loud log beats a classifier that silently stops covering a
  case nobody re-tested.
- **Three attempts may not beat a longer registry outage.** Deliberate: more attempts buy little and
  make a genuine failure slower to report.
- Only `build.yml` is covered. Every other workflow still installs directly and can still hit this.

## Alternatives considered

- **`actions/cache` around `node_modules` or bun's cache** — already measured and removed; a hit is
  slower than the install and the entries crowd out the Windows proof's cache budget. Re-adding it
  would also not fix a first-ever install on a cold cache.
- **A third-party retry action** (`nick-fields/retry`) — a supply-chain dependency in every CI job for
  what 30 lines of bash does, with no ability to clear bun's cache between attempts.
- **`continue-on-error` on the install step** — makes CI dishonest: the job would go green with no
  dependencies installed. Explicitly rejected.
- **Pinning or downgrading `mermaid`, or vendoring its tarball** — the failure is not version
  specific, and touching `bun.lock` on a developer machine rewrites resolution URLs to the private
  Wix Artifactory mirror, which breaks CI outright.
- **Lowering bun's network concurrency** — slows every install to maybe reduce a failure whose cause
  is a bad response body, not a race.
