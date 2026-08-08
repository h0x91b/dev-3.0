# 211 — The packaged Windows proof runs post-merge and before publishing, never on a pull request

**Supersedes the PR-gating half of `decisions/2026/08/06/required-checks-wait-for-windows-packaging.md`.**
Records are cited by full slug here, never by number: four numbering collisions happened in one day.
Everything 209 says about *why* the packaged Windows jobs matter, why the fix had to live in the repo,
and why the workflow became reusable still stands. What is reversed is the part that made the required
`test` context wait for them.

## Context

The gate 209 designed worked exactly as specified and both of its arms were observed live: an in-scope
PR waited for the packaged Windows jobs (PR #1266's own run 31083965892), an out-of-scope PR passed with
a loud `::warning` saying nothing had been proved (PR #1268's own run 31086243567).

It was reversed on cost, not on correctness. **The required context went green at +359 s against a
+72 s baseline — +287 s, i.e. +4 m 47 s on every in-scope PR.** And `WINDOWS_SCOPE_PATHS` deliberately
contains `.github/workflows/build.yml`, `package.json`, `electrobun.config.ts` and `release.yml`, so a
large share of ordinary infrastructure PRs are in scope. Arseny watched three `package-runtime` jobs
spin under the `windows package` caller on a live PR and ruled that waiting that long on every PR is
worse than the risk it removes.

**The fallback that made the scope list survivable did not exist.** 209's risk section offered, as a
partial mitigation, that "`release.yml` still packages Windows on every release, so the proof is not
skippable forever". `release.yml` contains **zero Windows**: its jobs are `prepare`,
`build-macos-arm64`, `build-macos-x64`, `build-linux-x64`, `build-linux-arm64`, `release`, and no step
in any of them touches Windows. This has been true the whole time. It is not a stale number or a typo —
it is a **safety argument resting on a fact that was never true**, and it was in the picture when the
coordinator ruled on the PR gate. Anyone re-reading 209 has to know the belt existed only in prose.

## Decision

**1. Windows packaging does not gate a pull request, in scope or out.** `build.yml` loses the
`windows_scope` and `windows_package` jobs, the `test` job loses them from `needs:`, and the four-case
gate step goes with them — including the `::warning` absence branch and the `WINDOWS_GATE` leg of *Fail
if any gate is red*. Nothing PR-side survives; this project replaces rather than deprecates.

**2. The proof runs post-merge on `main`** — `.github/workflows/windows-proof-main.yml`, `on: push:
branches: [main]`, calling the same reusable `windows-conpty-package.yml`. A break is detected within
roughly the packaging duration and is attributable to **one commit** rather than to a bisect over a day
of merges. This is the half chosen over "release-only", and it is why the scope machinery stays useful.

**3. The scope filter stays, over the pushed commit range** (`github.event.before..github.sha`), reusing
`WINDOWS_SCOPE_PATHS` and `scripts/windows-ci-scope.ts` unchanged. **The default when the range does not
resolve is the OPPOSITE of the PR side, and the two must never be "aligned":**

| Where | Scope undecidable | Why |
|---|---|---|
| PR gate (removed) | **fail** | a required context claiming "Windows was checked" on a guess is a lie someone merges on |
| Post-merge (`main`) | **prove** | nobody is waiting, so a needless proof costs minutes; skipping loses the only detector this platform has |

Force push, branch creation and the all-zero `before` all land in that branch and all dispatch the proof.

**4. A release fails when the Windows build fails, and the gate sits on the BUILD jobs.** Arseny: *if it
cannot build Windows at version-build time, then it should fail there.* `release.yml` gets a
`windows-proof` job calling the same reusable workflow, and **`windows-proof` is added to the `needs:` of
all four `build-*` jobs** — not to the `release` job.

The reason is that **publishing is decentralised**: `build-macos-arm64`, `build-macos-x64`,
`build-linux-x64` and `build-linux-arm64` each run their own `aws s3 sync`, and each syncs twice — once
to `s3://h0x91b-releases/dev-3.0/$TAG/` and once to the bucket **root**, which is the updater feed the
in-app `Updater` reads. Gating only `release` would fail the GitHub Release *after* macOS had already
shipped to updater clients: a partial ship wearing a failed release's clothes. **Do not simplify this
onto the `release` job.** **The release-side proof is unconditional BY DESIGN: a release never consults the scope list.** The
asymmetry with the push-to-main path is deliberate and must not be "unified". Post-merge, "nothing
Windows-relevant changed, so Windows was not proved on this commit" is an acceptable answer, because the
next in-scope merge will prove it and nothing has shipped. At release time it is not an acceptable answer
under any diff: shipping is the moment the claim becomes irreversible, so the proof runs regardless of
what changed. It runs on the dry-run paths (`test-*` tag, `workflow_dispatch`) too, which is where a
break should surface.

**5. The post-merge proof and the unstable channel are not redundant with each other, and this is a
reason rather than a condition.** The unstable channel (Seq 1443) **builds hourly, and only when `main`
actually moved**, with a manual dispatch for when a build is wanted immediately. Arseny merges in
**batches of four or five PRs**, so per-push would burn four sign-and-notarize cycles for one meaningful
artifact.

**An hourly build covers a RANGE of commits, so when it breaks it identifies the range, not the culprit.**
The dedicated post-merge proof is therefore the only thing in the system that attributes a Windows break
to **one commit**, and Windows remains the only platform with no local machine. That is what it is for;
it is not a stopgap waiting for the channel work to absorb it.

Stated as a reason on purpose: an earlier draft of this record made it conditional — "keep both until the
unstable path builds on every merge" — and **a conditional in a record invites someone to satisfy the
condition later.** If a future change ever does make Windows provable per commit somewhere else, folding
this proof in removes the last consumer of `WINDOWS_SCOPE_PATHS` and **cancels the scope-criterion task
rather than deprioritising it** — that consequence is recorded here so nobody folds it without noticing
what else dies.

**6. How a broken `main` gets noticed: GitHub's own notification, and nothing new.** A failed run on the
default branch notifies the **commit author**, and the commit carries a ✗ in the list. That works here
**only because one human authors every commit in this repo — it is not a general solution** and must not
be described as one. Auto-opening an issue was considered and declined: dedupe logic is maintenance
nobody asked for, and the mail already reaches the only maintainer.

## Investigation

Every workflow file that is read as **data** was grepped before reshaping anything, because that exact
class bit three tasks in one day:

| Reader | What it read | Outcome |
|---|---|---|
| `workflow-windows-gate.test.ts` | `build.yml`'s gate step and the scope command, by regex | Rewritten as `workflow-windows-proof.test.ts` for the new home — **rewritten, not widened** |
| `workflow-bun-pins.test.ts` | `WINDOWS_SCOPE_PATHS` as a typed import | Unaffected; its comment updated |
| `workflow-terminal-e2e-gate.test.ts` | `needs:` of `test` by **membership**, not exact list | Passes unchanged — the exact-list version would have gone red here |
| `windows-ci-scope.test.ts` | the module and the script | Unaffected; header updated |

**A rule that fell out of this work, non-obvious enough to state as a rule rather than as an incident:
the workflow that DISPATCHES the proof must itself be in `WINDOWS_SCOPE_PATHS`.** `workflow-bun-pins.test.ts`
went red on the new `windows-proof-main.yml` — it pins Bun, a Bun pin change *is* a packaged-runtime
change, and a workflow outside the scope list cannot dispatch the proof for its own edits, so editing
its pin would ship unproven. Fixed by adding the workflow to the list, not by loosening the assertion.
Anyone adding another proof-dispatching workflow will hit this blind.

The new tripwires detect release publishers **by behaviour, not by name**, so a per-channel job Seq 1443
invents is covered the moment it exists. Two independent detectors, because either alone fails silently:
one matches the upload command (`aws s3 sync`/`cp`), one matches the destination
(`s3://h0x91b-releases/`). **Each must find at least one publisher or the test is red** — a detector that
matches nothing would otherwise turn the whole file green by iterating an empty list. **The two detectors
are deliberately redundant and neither may be deleted as duplication: each is blind to a different
mutation — renaming the upload command hides jobs from the command detector, moving the bucket hides them
from the destination detector, and a single matcher lets one renamed job slip through while the others
keep the count non-zero.** All 18 mutations
were proven red on the intended assertion, including "rename the upload command" and "move the bucket".

## Risks

- **A Windows-breaking change can now merge green.** That is the thing being given up, stated plainly.
  It is caught minutes later on `main` instead of never — which is what the pre-#1266 status quo actually
  offered, since no required check ever waited for Windows before #1266 either.
- **The scope list stays load-bearing, but its failure mode is back to the mild one.** A file missing
  from `WINDOWS_SCOPE_PATHS` means "Windows was not proved on this merge", not a required context
  asserting Windows was checked-and-not-applicable. The escalation 209 flagged as its main risk is gone;
  the list itself is unchanged and still has no written criterion for membership (separate task).
- **A red run on `main` that nobody opens is worth nothing.** The notification is GitHub's default and
  reaches the commit author only. One human authors every commit here, so it lands today. A second
  committer would silently break this property.
- **Releases get ~6 minutes longer and can now be blocked by Windows.** Deliberate: that is requirement
  4. A flaky Windows job now blocks a release rather than a PR, and the known flake in the live-parser
  resize check is the likeliest way to meet it. Re-running the job is the response; lowering the gate is not.
- **`release.yml` is about to be rewritten by the update-channels work.** The `needs:` edges are cheap to
  re-add, but the guardrail is the test, not the YAML: any new publishing job that forgets the edge is
  named by the failing assertion together with the cause.

## Alternatives considered

- **Keep the PR gate and shorten the Windows jobs instead.** Rejected as the *primary* fix: even halved
  it is minutes on every in-scope PR, and lowering a job to make a gate's numbers look better defeats the
  gate. ⚠️ The reason given here originally — "the 306 s is mostly ~15 sequential E2E steps in one job" —
  **repeated 209's adjacent finding, and that finding has since been disproved by per-step measurement**:
  the E2E steps are 123 s of 486 s, while `bun install` on Windows is 255 s. See the corrected section in
  `decisions/2026/08/06/required-checks-wait-for-windows-packaging.md`. The rejection stands; only its
  stated reason was wrong.
- **Release-only, no post-merge run.** Simplest, and requirement 4 alone would satisfy "a break cannot
  ship". Rejected by Arseny: a break then surfaces at release time against a day or more of merges, and
  attributing it means a bisect. Per-commit attribution is the whole point.
- **Run the proof unconditionally on every push to `main`, deleting the scope machinery.** Genuinely
  simpler — no list, no absence branch, and it would make the scope-criterion question moot. Rejected:
  it deletes a module, a script, a test and one case of `workflow-bun-pins.test.ts` that landed 40
  minutes earlier, and post-merge runs compete for concurrency with PR checks.
- **Gate only the `release` job instead of the four build jobs.** Rejected on the decentralised-sync
  finding: the updater feed would already have been written.
- **Auto-open a GitHub issue when the post-merge proof fails.** Declined by Arseny — see decision 6.
