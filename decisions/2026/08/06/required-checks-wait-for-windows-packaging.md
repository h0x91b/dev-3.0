# 209 — The required checks wait for the Windows packaging proof

> **PARTLY SUPERSEDED by `decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md`.** The half of
> this record that makes the required `test` context wait for the packaged Windows jobs was **reversed**
> on measured cost: +4 m 47 s on every in-scope PR (run 31083965892). The proof now runs post-merge on
> `main` and in front of every release job that publishes. Nothing PR-side described below still exists.
>
> **Still valid:** why the packaged Windows jobs matter, why the fix had to live in the repo, the
> `workflow_call` conversion, and `WINDOWS_SCOPE_PATHS` as the single home for the path list.
>
> **Known false below:** the mitigation claiming `release.yml` packages Windows on every release. It
> never did — see the Risks note marked ⚠️ FALSE.

## Context

`main`'s required status checks are exactly `lint`, `test`, `build-check`, `trivy-scan` (read from the
branch protection API; `strict=false`). All four are fast Ubuntu jobs: measured over the 20 most recent
`pull_request` runs, they go green at roughly 60–70 s p50. The packaged Windows jobs —
`package-runtime (windows-latest)` p50 306 s and `windows-app-archive` p50 304 s, p90 ~350 s, worst
observed 462 s — are **not** required.

So the required set is systematically the fast jobs and the packaging proof is systematically unrequired.
A PR with auto-merge lands the moment the four go green, which is *before* the Windows jobs have decided
anything — by construction, every time, not occasionally. PR #1263 is the demonstration: it merged with
both Windows jobs pending; they went green five minutes later. A red one would have landed identically,
and the only trace would be a failed check on an already-merged PR nobody has a reason to reopen.

This matters more here than in most repos because `windows-app-archive` is the only thing that proves the
packaged Windows app launches and produces a UI, and Windows is the platform with no local machine —
CI is the sole detector. Three separate tasks hit this hole in one day.

The fix had to live **in the repo**, not in branch protection: a required-contexts list is configuration
outside the repo that drifts silently and that nobody remembers exists, whereas a `needs:` edge travels
with the code and shows up in a diff.

## Investigation

Two facts killed the obvious implementation.

1. **`needs:` is intra-workflow only.** The two Windows jobs live in `windows-conpty-package.yml`, not
   `build.yml`, so no job in `build.yml` could depend on them. The sibling change that gated the live
   terminal e2e (`terminal_e2e`, seq 1422) was cheap precisely because its job was already in the same
   file as the required context.
2. **The hole is worse than "skipped looks like success".** `windows-conpty-package.yml` carried a
   45-entry `on.pull_request.paths` filter. When nothing matches, the workflow does not trigger at all —
   there is no check run, so `needs.<job>.result` would never exist to be read and a gate depending on it
   would sit *pending forever*, blocking every out-of-scope merge in the repo. This is not theoretical:
   of the last five merged PRs, #1263, #1261, #1260, #1258 ran the Windows checks and **#1259**
   (renderer-only) produced none at all. Roughly one PR in five is genuinely out of scope.

## Decision

`windows-conpty-package.yml` becomes a **reusable workflow** (`workflow_call`, keeping
`workflow_dispatch`); its `on.pull_request` trigger and its paths filter are **deleted**. `build.yml`
calls it as a job, so `needs:` works, and the already-required `test` job takes the call as a dependency —
no branch-protection change.

The path filter is replaced by code, in one place:

- `src/shared/windows-ci-scope.ts` — `WINDOWS_SCOPE_PATHS` plus `matchesWindowsScope` / `windowsScopeHits`.
- `scripts/windows-ci-scope.ts` — the `windows_scope` job runs it over the PR diff and emits `in-scope`.
- The called workflow is gated on that output, so an out-of-scope PR keeps today's cost profile.

The gate step in `test` follows the idiom seq 1422 established (`::warning` / `::error` sharing one
`title=`, one `$GITHUB_STEP_SUMMARY` line per branch, `continue-on-error` on the verifications with a
final step failing on either, so a red Windows gate never hides which test shards failed). It has **four**
cases where 1422 has three:

| `windows_scope` | `in-scope` | Windows package result | Verdict |
|---|---|---|---|
| not `success` | — | — | **hard fail** — a gate that cannot compute scope never assumes "fine" |
| `success` | `false` | `skipped` | pass, loudly announced (see below) |
| `success` | `true` | `success` | pass |
| `success` | `true` | anything else, incl. `skipped` | **hard fail** — a skip for any reason other than scope is not a pass |

The fourth row is the addition: because `skipped` is now *reachable and legitimate*, it is only ever a
pass when cross-checked against the scope output.

**The artifact holding the absence branch open** is the `::warning title=Windows packaging gate::` line
and its `## ⚠️` run-summary line in the `windows_gate` step of `build.yml`, worded as what was *not*
proved rather than "skipped". `src/bun/__tests__/workflow-windows-gate.test.ts` pins them by parsing
`build.yml` as raw text (same approach as `workflow-bun-pins.test.ts`; do not import `yaml`, it is not a
declared dependency) and asserts the branch emits both and does **not** `exit 1`. Mutation-checked both
ways: deleting the warning fails the test, adding `exit 1` fails the test.

That pin is itself a test consuming a file as **data**, with no type checking on the link — the same class
of fragile interface this change removed elsewhere (`workflow-bun-pins.test.ts` used to read the deleted
`paths:` filter by regex, and it now reads `WINDOWS_SCOPE_PATHS` as a typed import instead). Parsing raw
YAML is accepted here because there is no other way to pin a shell branch. The mitigation is the failure
message: **when this pin fails it must say the pinned string moved and name the fix — update it in this
test — never merely restate the invariant.** Anyone reshaping the gate step will trip it, and a failure
that misdescribes its own cause sends the next reader after a phantom regression.

**One level deeper than the gate can see.** The gate reads the *caller* job's result, and a called
workflow whose internal job skips can still report success to its caller. A job-level `if:` inside
`windows-conpty-package.yml` would therefore pass the gate on a package that never packaged — the same
absence-looks-like-success hole, hidden where no cross-check reaches. Rather than depend on GitHub's
exact semantics here (not verified empirically, and not worth depending on either way), the dependence
is removed: `src/bun/__tests__/workflow-windows-gate.test.ts` asserts the called workflow has no
job-level `if:` and no job-level `continue-on-error`, so scope can only be expressed where the caller
evaluates it and the gate cross-checks it. Mutation-checked by adding `if: false` to
`windows-app-archive` and watching the tripwire name that job.

## Risks

**The path list is now load-bearing in a stronger way, and this is a real escalation.** Before, a file
missing from the list meant Windows silently did not run. Now the same miss makes the required `test`
context go green *while asserting that Windows was checked and not applicable*. The claim got stronger;
the thing it rests on did not.

For the list to be wrong, only this has to be true: someone adds or moves a file that changes packaged
Windows behaviour and does not add it to `WINDOWS_SCOPE_PATHS`. Nothing in CI can detect that — the whole
point of the list is that it is a human judgement about which files matter. How anyone finds out today:
the regression reaches `main`, and the next PR that *does* touch a listed path fails the Windows job for
reasons unrelated to its own diff. Partial mitigations in place: the list contains
`src/shared/windows-ci-scope.ts` and `scripts/windows-ci-scope.ts`, so a change to the decision mechanism
cannot judge itself out of scope; the run summary always prints how many changed files matched, so an
out-of-scope verdict is visible rather than silent.

  ⚠️ **FALSE — this line claimed `release.yml` still packages Windows on every release, so the proof was
  not skippable forever. `release.yml` contained zero Windows, and had the whole time.** This was not a
  stale number: it was a safety argument resting on a fact that was never true, offered while ruling on
  the PR gate. A Windows proof was added to the release path only in
  `decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md`.

Other risks:

- **Wall-clock: the required `test` context goes from roughly 1 m 10 s to 6 m 00 s on in-scope PRs, and
  is unchanged on out-of-scope ones — about +4 m 45 s.** Measured on run 31083965892, the gate's first
  live run: `test` green at +359 s against a +72 s baseline (slowest shard 67 s plus a 5 s aggregator),
  so +287 s. This line first said +4 minutes and was 47–49 s optimistic, because that estimate was
  derived from per-job durations. `windows-app-archive` ran 5 m 31 s of *duration* yet completed at
  +348 s, because the called workflow does not dispatch until `windows_scope` reports and the scope job
  is serial in front of the packaging jobs by design. **So the added wall-clock is scope job + dispatch
  latency + slowest packaging job, minus whatever the old critical path already covered — never
  `max(packaging durations)`, which underestimates by roughly the scope job.** The critical path without
  the gate is the test shards at ~1 m 07 s (run 31082720488, where the live terminal e2e legs at 1 m 01 s
  and 41 s sat under it and cost nothing). The packaging jobs do not sit under it: `package-runtime
  (windows-latest)` and `windows-app-archive` are ~305 s p50 each, p90 ~350 s, worst observed 462 s. So
  unlike the terminal gate, this one does move the critical path, by design. Per-job durations exclude
  runner queueing, so treat them as a floor. Accepted deliberately — a cost, not a rounding error.
- **`strict=false` is untouched and this change does not improve it.** PRs need not be up to date with
  `main`, so the Windows proof can be green against a stale base and merge onto a moved one. Worse, the
  scope decision is computed from the PR's own diff, so a file that becomes Windows-relevant on `main`
  after the PR forked is invisible to it. Mechanically unchanged, rhetorically worse: an advisory job
  going green against a stale base was noise, a required gate doing it is a claim. Not changed here.
- **The trigger widened for the callee's sibling jobs.** `posix-app-package` and the macOS/Ubuntu legs of
  `package-runtime` now run whenever the caller invokes the workflow, i.e. on in-scope PRs only — the same
  condition as before, expressed in code instead of YAML.

## Alternatives considered

- **Change branch protection to require the Windows contexts.** Rejected by the user: out-of-repo
  configuration that drifts silently and is invisible in a diff.
- **Move the two Windows jobs bodily into `build.yml`.** Rejected: it forks a 300-line matrix away from
  its posix siblings, and the paths filter would have to be re-expressed per job anyway.
- **Convert to `workflow_call` and drop the filter entirely, running Windows on every PR.** Simplest, and
  it has no absence branch at all — but it taxes every docs-only PR five minutes on three Windows-billed
  runners. A gate people resent is a gate that gets removed.
- **Poll the GitHub API from `build.yml` for the other workflow's conclusion.** Rejected: it has to
  replicate the paths filter to know whether a run should exist, which is the duplicated-list drift this
  design exists to avoid.

## Adjacent finding — ⚠️ DISPROVED BY MEASUREMENT, see below

  ⚠️ **FALSE.** The original text claimed `package-runtime`'s Windows leg spends its ~306 s "largely on
  roughly 15 sequential E2E steps in one job", and suggested splitting or parallelising them as the
  cheaper fix. **The E2E steps are not where the time goes.** The claim was never measured per step; it
  was inferred from reading the step list, and it sent Seq 1435 ("Speed up the Windows CI leg") off with
  the wrong diagnosis already written into its description.

**What the per-step numbers actually say** — release run 31248826195 (v1.42.1), attempt 2,
`package-runtime (windows-latest)`, 486 s total:

| Step | Time | Share |
|---|---|---|
| `bun install --frozen-lockfile` | **255 s** | **52%** |
| `Build packaged runtime tracer` | 76 s | 16% |
| All 19 E2E steps together | 123 s | 25% |
| Set up, checkout, Bun, uploads, teardown | 32 s | 7% |

`windows-app-archive` in the same run pays the same tax: `bun install` 249 s of its 456 s (55%).

**The install is Windows-specific, not network-bound.** Same command, same lockfile, same run:
ubuntu 4–5 s, macOS 10–36 s, **windows-latest 255 s and 249 s** — a ~50× gap. There is no `actions/cache`
anywhere in `windows-conpty-package.yml`, while `build.yml` has cached `./node_modules` under
`bun-deps-linux-x64-${{ hashFiles('bun.lock') }}` the whole time. Both Windows jobs run in parallel and
both pay it, so this one step sets the duration of the entire `windows-proof` gate.

The original advice is not merely imprecise, it is inverted: perfectly parallelising all 19 E2E steps
would save at most ~2 minutes, and the install is over 4. Measured under Seq 1472; the cache fix and its
cold/warm numbers live there.

Unchanged from the original: lowering a job to make the gate's numbers look better would defeat the gate.
Caching dependency installation proves exactly as much as installing them.
