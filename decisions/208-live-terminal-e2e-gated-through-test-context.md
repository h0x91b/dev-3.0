# 208 — Live terminal e2e gates PRs through the required `test` context

## Context

Seven end-to-end scripts (`test:tmux-guarded-send-e2e`, `test:pane-input-owner-e2e`,
`test:pane-input-native-e2e`, `test:native-registry-e2e`, `test:native-owner-routing-e2e`,
`test:native-multipane-e2e`, `test:native-message-e2e`) prove the only guarantees a unit
test cannot reach: guard grammar against a live tmux server, recycled pane ids across a
server restart, exactly-once delivery across three OS processes, ownership-verified
teardown. CI never ran them, so reviewers repeatedly had to write "cannot verify by
reading" — and both real bugs found during seq 1411's review came from live measurement,
never from code reading.

## Investigation

Measured locally on macOS (Apple silicon), each script run through
`bun scripts/run-terminal-e2e.ts`: 6.4 s + 3.8 s + 0.6 s + 1.4 s + 1.0 s + 1.4 s + 12.4 s
= **27.0 s** of script time for the whole set. That is cheap enough that splitting into a
per-PR subset and a main-only remainder would buy nothing and hide coverage, so the whole
set runs on every PR on both runners.

### `app A never reported readiness` means a missing generated module, not a hung app

Two of the seven scripts cannot run from a bare checkout, and one of them says so in the
most misleading way available. `native-message-e2e` loads the production RPC handlers,
which import the generated `src/bun/changelog-bundled.ts`; without
`bun scripts/generate-changelog.ts` it dies before its first check with
`Cannot find module '../changelog-bundled'`. That one is at least honest.

`pane-input-owner-e2e` fails from the **same** cause and reports
`error: app A never reported readiness` **after waiting 90 seconds** — because the process
that dies is its owner subprocess, and only its last ten stderr lines are surfaced. Anyone
meeting that symptom will go looking for a timing bug, a lease bug, or a hung host. It is
none of those. **Run `bun scripts/generate-build-info.ts && bun scripts/generate-changelog.ts`
before debugging anything else.** The workflow does exactly that, in a step whose comment
says why.

### `skipped` cannot be treated as a failure

Branch protection on `main` requires exactly four contexts: `lint`, `test`, `build-check`,
`trivy-scan`. A new job is not required by default — that is why the Windows packaging
jobs can sit pending forever without blocking a merge.

Gating through `needs` therefore means the gate step reads `needs.terminal_e2e.result`, and
that value is not two-valued. Audited at the time of writing: `build.yml` triggers only on
`pull_request` to `main`, has **no** `paths` filter, **no** workflow- or job-level
`concurrency` group, and `terminal_e2e` has **no** `if:` condition — so `skipped` is
unreachable today. But if anyone later adds a job-level `if:`, failing on any non-`success`
value would turn the required `test` context red on **every** PR that does not touch
terminal files, and nothing in the repo could merge.

A **workflow**-level `paths` filter is a different failure, guarded by a separate tripwire:
the workflow would not trigger at all, so there is no check run, `needs.terminal_e2e.result`
never exists to be read, and the required `test` context sits **pending forever** rather than
going red or green. That is exactly the symptom the Windows packaging jobs already show, and
the reason this gate deliberately lives in the same workflow as the context that requires it
rather than in a second one.

Note which risk is which, because the two are easy to merge and then mis-guard. Silent green
needs an **asymmetry**: this job absent while `test` still runs. Only a job-level `if:` produces
one, because it is the only mechanism that yields `skipped` for this job alone — and `skipped`
is the case the gate passes. A job-level `concurrency` cancel yields `cancelled`, which the gate
already fails hard on, so it needs no tripwire at all. Every file-level mechanism takes `test`
down with the whole workflow, so it cannot go silently green; it can only go pending, which is
the second tripwire's business.

## Decision

`terminal_e2e` in `.github/workflows/build.yml` runs the whole set on a
`[ubuntu-latest, macos-latest]` matrix, and the already-required `test` job takes it as a
`needs` dependency. The gate therefore blocks merges on day one without editing branch
protection — a `needs` edge lives in the repo and shows up in a diff, while a
required-context list is user-owned configuration that drifts silently.

The gate step reads `needs.terminal_e2e.result` as three cases, not two: `success` passes,
`skipped` passes with a loud `::warning` and a run-summary line saying nothing was verified
live, and anything else (`failure`, `cancelled`) fails. Skipping cannot be allowed to fail
the required context (see above), and it cannot be allowed to pass silently either.

`scripts/run-terminal-e2e.ts` is the runner: it times each script, and after every script
diffs live processes and temp-dir entries against a baseline taken before the run. A
surviving native host, tmux server, shell, or throwaway temp dir **fails** the run rather
than being logged — attributably anywhere, unattributably in CI (see the footprint section
below). The verdict logic is pure, in `src/bun/terminal-e2e-guard.ts`, and unit tested
(`src/bun/__tests__/terminal-e2e-guard.test.ts`) — a guard that silently stops detecting
looks exactly like a clean run.

Inside the `test` job both verifications are `continue-on-error` and a final step fails on
either, so a red terminal gate never hides which test shards also failed.

## Risks

- Adding `terminal_e2e` to `test`'s `needs` means the required `test` context now waits on
  a macOS runner, so PR feedback is as slow as the slowest of the two runners.
- The orphan scan is a pattern match on `ps` output plus a baseline diff. A process of ours
  whose argv carries none of the `dev3-*` / `d3or-*` markers would go unseen; the markers
  live in `OUR_PROCESS_PATTERNS` next to a comment saying so.
- A leaked process of ours whose argv does not carry the repo root — a stranded `cat` under a
  temp root, for instance — is unattributable, so on a developer machine it is only reported.
  In CI it still fails, which is where the gate has to work; locally it is a warning that can
  be missed, and `AMBIGUOUS_LOCAL_WARNING` is the only thing standing in that hole.
- Runtimes above are macOS-local. CI runners are slower, and the honest number lands in the
  run summary table rather than in this file.
- Treating `skipped` as a pass means that if a path filter is ever added to this workflow,
  the gate stops proving anything on most PRs and only a `::warning` says so. That is the
  lesser of the two evils — the alternative blocks every merge in the repo — but it is a
  real hole, and the warning text is the only thing standing in it.

## Alternatives considered

- **A separate workflow, added to branch protection.** Cleaner job naming, but requires a
  repo-settings change to gate anything, and until that happens it is a job people learn to
  ignore — the exact failure mode being fixed.
- **Fast subset per PR, whole set on main.** Rejected: 27 s does not justify it, and a
  narrowed suite reads as coverage it does not have. The `--set fast` tier exists so the
  split is a named one-word change if measurement on real runners ever demands it.
- **Fold the scripts into the sharded vitest run.** Impossible: vitest stubs the `Bun`
  global, so a live `Bun.Terminal` cannot run there — the reason these are standalone
  `bun` scripts at all.

## The gate wiring is itself pinned by a test

`src/bun/__tests__/workflow-terminal-e2e-gate.test.ts` asserts against `build.yml` directly
(raw text, same approach as the sibling `workflow-pipefail` / `workflow-bun-pins` tests):
the job runs both OSes without fail-fast, generates build files before the scripts, is a
`needs` of `test`, and the gate step emits the `::warning` **and** the run-summary line on
`skipped` while never exiting non-zero there.

That last one is the point. The `::warning` string is the only thing standing between a gate
that stopped running and a silent green, and an untested string is decoration. Verified by
mutation: deleting the annotation line fails the test, and so does adding `exit 1` to the
skipped branch.

The same file carries two tripwires, each asserted at the level its own failure lives at and
no wider — a scan that reds a correct change is the worst kind of red:

- **No `if:` on the `terminal_e2e` job**, scoped to that job's own block. This is the
  load-bearing one: a job-level `if:` is the only mechanism that can leave this job absent
  while `test` still reports, and `skipped` is the case the gate passes.
- **No workflow-level `paths` filter**, file-wide, because that damage is file-wide: it leaves
  the required `test` context with no check run to read.

Deliberately NOT asserted: `concurrency`, at either level. A cancelled job reports `cancelled`,
which the gate already fails hard on, so forbidding it would block a reasonable future change
(cancel superseded runs) for no safety gain. The scans are also bounded to one job block rather
than "up to the `test:` key", so a sibling task adding jobs to this file cannot have its keys
judged as ours.

## Attribution is by our own footprint, because "looks dev3-ish" is not ownership

The gate went red once on a clean tree, and the cause was neither a leak nor tmux. The
runner breaks its loop on exactly one condition — a survivor — so the failure could only
have been a survivor detection; a non-zero script exit records `FAILED` and carries on.
Investigating live process lists on the developer machine found the producer: **sibling
worktrees running these same e2e scripts at the same time.** Their processes carry the same
hard-coded session ids (`dev3-task-00000000-0000-4000-8000-…`, seen live under another
worktree's path) and are therefore "new" against our baseline. The same machine also runs a
dozen real native hosts for real tasks, and one that starts mid-run is new by construction.

So looking like the suite identifies the **suite**, never the **run**. A survivor is ours
only when its argv names something only this run can have touched — our repo root
(`RunFootprint`). Anything else that looks like the suite is **unattributable**: a failure in
CI, where a single checkout and no running app make ambiguity impossible, and a reported
warning on a developer machine, where calling it a leak would cry wolf. Temp roots carry no
repo path and are judged the same way. The guard genuinely has different truth conditions in
the two environments; pretending otherwise in either direction is the bug.

Two more consequences of that red run:

- **A survivor must survive twice.** The check now takes a second look after a two-second
  settle, so a process still tearing down is never reported as a leak.
- **The evidence is written to a file and uploaded.** The original detail existed only on
  stdout and was destroyed by a `tail -3`, which cost a day of guessing. `renderEvidence`
  writes every survivor — including the ones that only warned — to
  `terminal-e2e-evidence/survivors-<platform>.txt`, into the run summary, and into a CI
  artifact on failure.

`AMBIGUOUS_LOCAL_WARNING` is now the only thing standing between an unattributable survivor
and a silent local pass, so it is pinned by a mutation-checked test exactly like the skip
warning: blanking the string fails the suite.

## One vocabulary for "the slow gate did not report"

Seq 1433 built the same shape for the Windows packaging jobs and took this file's idiom:
`::warning` / `::error` carrying the same `title=`, one `$GITHUB_STEP_SUMMARY` line per branch,
both verifications `continue-on-error` with a final step failing on either, and the did-not-run
message saying what was **not proved** rather than that something was skipped.

Its case needed one case more than this one, and its wording is the one to adopt if this gate
ever grows a scope filter. There, `skipped` is both reachable and legitimate — it is how
out-of-scope expresses itself — so branching on `skipped` alone would make a deliberate absence
indistinguishable from someone adding a `concurrency` group. The pass-with-a-warning arm is
therefore not "skipped" but **deliberately not dispatched**, and it requires a second,
independently computed reason for the absence; a skip for any other reason still fails hard.
"Skipped" is a symptom, "deliberately not dispatched" is a claim someone can be wrong about,
which is what makes it testable.

This gate keeps three cases for one precise reason: the only mechanism that can leave it absent
while the required context still reports is a job-level `if:`, and that is what its tripwire
forbids. If that assertion is ever relaxed — or if scoping ever arrives here — three cases stop
being enough and the four-case shape replaces them.
