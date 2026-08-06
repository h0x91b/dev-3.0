# 221 — Extract the per-platform release builds into reusable workflows

Companion record: `decisions/218-stable-unstable-update-channels.md` (cited by slug, never by
number — decision numbers in this repo collide routinely between unmerged siblings). That record
owns what a channel *is*; this one owns the release-pipeline refactor that had to land first, and
everything the refactor taught. The two are independent: either can merge before the other and
`main` stays coherent.

## 1. Context

Adding a second update channel needs the same four per-platform build jobs to run under a
different `--env`, from a different trigger, without publishing to the stable feed. `release.yml`
held those four jobs inline — ~670 lines of duplicated steps — so a second trigger meant a fifth
and sixth copy. The builds were extracted into two reusable `workflow_call` workflows first, as a
change with no user-visible behaviour, so the channel work lands on top of one definition per
platform family instead of two.

**The gate for a no-behaviour-change refactor cannot be a green suite.** A wrongly-skipped step
still produces artifacts and still goes green. So the gate was artifact equivalence proved by real
release runs, and everything below came out of building that gate honestly.

## 2. Decision

`.github/workflows/release-build-macos.yml` and `release-build-linux.yml`, called four times from
`release.yml` with `secrets: inherit`. **Every input is required, none defaulted** — `arch`,
`runsOn`, `channel`, `tag`, `publish`, plus `bestEffort` on Linux. A defaulted `channel` would let
a future caller publish one channel's build into the other channel's feed with every test green.

**Two reusable workflows, not one.** Enumerating the four jobs showed the two macOS jobs are
step-for-step identical, while the Linux pair differs in six ways. One shared file would have
required inventing `if:` branches that do not exist today — a rewrite wearing an extract's
clothes. A required enum input to select step order was rejected for the same reason: a declared
conditional is still a conditional.

The extract therefore carries exactly **two deliberate behaviour changes**, both named rather than
absorbed:

1. the x64 artifact/CLI step ordering is unified to CLI-first (safe: the two scripts write
   disjoint files into a shared directory, neither removes it, and the CLI step writes no JSON for
   the wholesale `update.json` rewrite to discard);
2. a missing `linux-arm64` GUI bundle now shows as a failed-but-continued step instead of a
   passing step with a `::warning::` annotation.

And **one dead-branch repair**, deliberately in its own category because it is a different kind of
claim: the two changes above altered code that worked, while item 2 of section 6 repairs code that
had never run.

### Manifest identity fields

`create-release-artifacts.sh` is the single writer of the published `update.json`, and it now
writes two more fields on **every** channel — one code path, no branch to get wrong:

| Field | Question it answers |
|---|---|
| `sha` (`git rev-parse HEAD`) | WHICH COMMIT this build came from |
| `buildOrder` (`git rev-list --count HEAD`) | WHICH OF TWO BUILDS IS NEWER |

Neither is derivable from the other, and a re-run on the same commit reproduces both. They live
here rather than in the channel record because they are what the extracted workflow was proved to
publish (`Manifest identity: sha=… buildOrder=1599`, run 31104425148 attempt 1); who *reads* them
belongs to `decisions/218-stable-unstable-update-channels.md`.

`buildOrder` is monotonic **only because `main` is squash-merged**: its history is linear, so the
count rises by exactly one per merge. That is a property of how this repo lands pull requests, not
of git. Allow merge commits onto `main` and two different builds can share a count.

## 3. `WINDOWS_SCOPE_PATHS` is a union of two invariants, not one

`WINDOWS_SCOPE_PATHS` (`src/shared/windows-ci-scope.ts`) looks like one list with one meaning, and
it is not:

1. **ships into, or is exercised by, the packaged Windows proof** — `windows-conpty-package.yml`,
   the host-image scripts, the native terminal registry;
2. **carries the Bun pin every workflow must hold in lockstep** — drift there means the repo's
   pins no longer agree, so the packaged proof stops being evidence about the runtime anyone
   actually ships. This is why `electrobun.config.ts` and `package.json` are on the list even
   though neither builds Windows.

The extracted build workflows are **IN under (2) and OUT under (1)**: `release.yml` builds no
Windows at all — it *calls* `windows-conpty-package.yml` as a proof job — so the extracted files
carry macOS and Linux only, while still installing the Bun that builds and ships the app.

Two reasons feeding one list is not a contradiction. Each entry therefore states **which criterion
earned it**, and an entry may only be deleted by defeating that specific reason. Membership is
decided by criterion, never by resemblance to the entries already there. The comment that
previously justified the workflow entries by the packaged-runtime reason alone was stale after the
extract and now names both.

**Known gap, owned elsewhere:** `scripts/free-build-folder.ts` (the `preBuild` hook added by
#1279) is missing from the list and belongs on it. It is deliberately not added here — Seq 1457
owns that entry, and adding it in this PR would collide.

## 4. The scope of an assertion is the scope of the property it asserts

A property every workflow must hold is enumerated across the whole directory, with its own
zero-target assertion; a property of one named workflow is read from that file by name, and
directory-scoping it would be meaningless rather than safer. Written in
`workflow-windows-proof.test.ts`, the file that mixes both scopes and so proves the distinction is
real.

**A detector that matches nothing must fail.** Every widened check carries a
find-something-to-check assertion, because the alternative is an empty set iterating cleanly. Not
hypothetical: after the extract, the assertion that every publisher carries the Windows-proof edge
PASSED — on an empty publisher list.

## 5. An equivalence gate needs an anchor OUTSIDE the change

The gate was specified as artifact equivalence, baseline versus extract. **Both of those points
sit inside the change**, so two identically broken runs satisfy equivalence perfectly — and that
is exactly what happened. `build-macos-x64` failed in both, every other platform passed in both,
and the extract was genuinely equivalent *including in its failure*.

What caught the bug was a third leg outside the change: **v1.42.0's real release run** (run
31091740061, attempt 1), which had succeeded on that platform. My own pre-extract baseline could
not serve as that anchor, because the bug was introduced by the channel parameterisation that the
baseline already contained — the baseline was broken too, and equally.

So the rule is not "compare before and after", it is: **an equivalence gate needs an anchor
outside the change, or it can only prove you broke nothing new.** Anyone copying this gate should
copy the three-legged version.

Stated plainly because it is the whole lesson: *I would have shipped it if I had reasoned from
"both runs match, therefore fine".*

### Dry-run evidence — four runs, cited with attempt numbers

**A rerun overwrites the run conclusion.** After a `--failed` rerun, `gh run list` and the run
header report SUCCESS and the red attempt is reachable only through the attempts API. A bare run
id therefore cannot be cited; the attempt number is part of the citation. This was watched happening
in real time on run 31104425148 — the red conclusion was visible, then it was not, on the same run
id with no code change. A sibling task had already concluded from exactly this that `main` had never
been red.

| Run | Attempt | Tag / tree | What it proved |
|---|---|---|---|
| 31098887428 | 1 | `test-channels-baseline` (pre-extract) | the baseline itself was already broken on `build-macos-x64` — `cp: : No such file or directory` |
| 31098996866 | 1 | `test-channels-extract` | the extract is equivalent to the baseline **including in its failure**; the gate as specified would have passed |
| 31100558183 | 1 | `test-channels-extract2` | first fully green run: the `cp` fix works, and the published inventory matches the v1.42.0 anchor name-for-name |
| 31104425148 | 1 | `test-channels-extract3` (post-rebase) | Case 2 recovery executed **past** the point that killed runs 1 and 2, and `Manifest identity: sha=… buildOrder=1599` published from the extracted workflow — then `build-macos-x64` FAILED at `hdiutil`, `No space left on device` |
| 31104425148 | 2 | same tree, failed job only, no code change | `build-macos-x64` SUCCESS; the disk failure is **transient** |

The red attempt of run 4 carried more than a green would have. Its own recovery branch printed
`Electrobun artifacts not found, recovering from build dir…` and then `Bundle hash: fvpey0cr9nb3,
version: 1.42.0` — the exact branch whose `cp: :` killed runs 1 and 2, confirmed on a real runner
rather than in a unit test. It reached the manifest step and published both identity fields from
the extracted workflow, which is the single most load-bearing property of the extract. A failure
at the DMG step *after* both of those is a run that did its job and then hit the floor.

Run 4 existed because a rerun of run 3 could not have replaced it: the tree had been rebased onto
#1279, which adds a `preBuild` hook that runs before **every** platform's build, and onto #1271,
which put the packaged Windows proof on the release path — so the anchor v1.42.0 has no
windows-proof jobs at all and only a fresh run could exercise that edge.

**Residual, named rather than left silent:** a release build whose DMG step sits close enough to
the disk ceiling to fall off is a latent flake on the **release** path — the one path where a
failure costs a shipped version. Seen once (run 31104425148, attempt 1) and not on the second
attempt of the same tree. No step prints free space, so nobody can say how close the margin is,
and `hdiutil` is not the mechanism, only where it surfaced. A `df` step was deliberately NOT added
here; it is a diagnostic for a different task.

**Tag provenance rule:** `git rev-parse <annotated-tag>` yields the **tag object**, not the commit,
so it prints a hash that appears on no branch and reads like a lost tree. Always
`git rev-parse <tag>^{commit}`. This cost one nearly-published wrong claim about which commit a
dry run had built.

## 6. The dry-run guard was PER-STEP, and a reusable workflow cannot inherit it

Found while extracting, before the mistake existed. It is the most dangerous line in the refactor
and it would have failed silently and green.

A `test-*` tag publishes NOTHING today, and the mechanism is per-**step**, not per-workflow:
`release.yml`'s `prepare` sets `publish=true` only when the event is a push AND the tag matches
`v*`; all eight `aws s3 sync` calls live in four steps each carrying
`if: needs.prepare.outputs.publish == 'true'`; the `release` job (GitHub Release + brew) carries
the same condition at job level. Because the gate is on the steps, it applied to every dry run
too — nothing a `test-*` tag could have left in the feed.

**A reusable workflow cannot read its caller's `needs` context.** Moving those steps into one
without re-gating them would have turned every future dry run into a live publish to the updater
feed real users poll, while the run stayed green. So `publish` is a REQUIRED boolean input and the
guard is `if: inputs.publish`.

One level up, the same catastrophe has a second route: a job output is a **string** (which is why
the original compares it to `'true'`). Passing the raw output to a boolean input means a non-empty
`"false"` arrives truthy, `if: inputs.publish` is satisfied, and the dry run publishes — with the
new `if:` present and correct. Callers therefore MUST pass an explicit comparison,
`publish: ${{ needs.prepare.outputs.publish == 'true' }}`.

Both are asserted in `workflow-windows-proof.test.ts`, which now enumerates publishers across
every workflow and follows `workflow_call` indirection — a publisher inside a reusable workflow is
guarded by its callers, and every caller must carry the edge. **Two independent properties hang
off that one enumeration** — gated by the Windows proof, and gated by `publish` — asserted
separately because a publisher can satisfy either while violating the other. They look redundant;
deleting either as duplication is how one dies.

The call-site assertion matches `publish:` only inside a `with:` block, because `prepare` declares
an output of the same name at the same indent — a bare indent match reports a false positive.

## 7. Two recovery paths were DEAD, not merely untested

`create-release-artifacts.sh` has a recovery half (Case 2) that runs when electrobun crashes after
tarring. THREE of its branches had never worked:

1. **The staged copy** used `$EBUN_TAR_ZST` — the Case 1 variable, which is EMPTY by definition in
   Case 2, since that emptiness is the branch condition. Result: `cp: : No such file or
   directory`. Introduced by this task's own channel parameterisation, caught by the dry runs
   above (runs 31098887428 and 31098996866, attempt 1 each, `build-macos-x64`).
2. **The compress-the-tar branch** called `"$ZSTD" "$TAR" -o "$TAR_ZST"`. `zig-zstd` requires a
   subcommand and `-i`; called positionally it prints usage and exits `error: InvalidArgs`. Dead
   since `571f038dd` ("feat: add x64 (Intel) macOS builds", #12, **2026-03-01**) and present
   unchanged on `main` — **five months** of a branch that could never run, because the only way in
   is electrobun dying between tar and compress.

A recovery path with no test is code that runs for the first time on the worst day, and this file
proved that class is live rather than theoretical: **three of eleven failure-only branches were
dead, not merely untested** — a 27% dead rate, measured rather than suspected.

**27% is a FLOOR, not an estimate.** The number moved from 18% to 27% because a *passing* test was
found to be passing on a broken path. Nothing rules out the same being true of another branch that
currently looks covered.

### Asserting an artifact exists is not asserting the script succeeded

This is the sharpest finding in this record, and it deserves its own name rather than a line in the
dead-path count.

The third dead branch was **covered by a passing test.** That test asserted the `::notice::` text
appeared and the staged tarball existed. **Both are true on the broken path**, because staging
happens before the failure. The test was not weak — it was measuring the wrong end: it verified that
things had *happened*, never that the script *finished*. Adding `expect(result.status).toBe(0)` is
what turned it red.

Every other finding in this record is a variant of *absence reads as success* — a skipped job, an
empty checks list, a rerun overwriting a conclusion, a zero-target detector, a silent `--env`
fallback. This is the sharpest form of it, because **the absence was wrapped in a passing test.**
Anyone auditing coverage would have ticked that path off.

The mechanism: `find_version_json` returns its path **on stdout**, and its `::notice::` went to
stdout too, so the caller captured both lines and the next `bun -e "Bun.file('<two lines>')"` died
with `Unterminated string literal`. The rule that prevents the whole class — **a function's stdout
IS its return value, so every human-readable line goes to stderr** — is written at that function,
where a future editor will read it.

**The enumeration itself is the map**, recorded in full so the next person editing these scripts
does not pay what it cost to rebuild it.

`create-release-artifacts.sh`

| # | Failure-only path | Verdict |
|---|---|---|
| 1 | missing `<channel>` argument → error | covered |
| 2 | unknown channel → error | covered |
| 3 | Case 2 entry: recover from a tar left in the build dir | covered (was DEAD — the empty-copy bug) |
| 4 | Case 2: tar present, no `.tar.zst` → compress it ourselves | covered (was DEAD five months) |
| 5 | `find_version_json` fallback: `version.json` off the expected path → `::notice::` | covered (was DEAD — the notice was captured into the path) |
| 6 | Case 2: neither tar nor `.tar.zst` → "build failed before tarring" | covered |
| 7 | Case 2, macOS: partial `.app.zip` → error naming notarization | covered (pre-existing test) |
| 8 | `find_version_json`: not found anywhere → `::error::` return 1 | **left** — needs a bundle with no `version.json` at all, which no real build produces; two lines, loud failure |
| 9 | Case 1: artifacts exist but no electrobun `update.json` → recover version from the `.tar.zst` | **left** — requires real electrobun output in a state that cannot be honestly fabricated |
| 10 | Case 1, macOS: no electrobun DMG → build one from the build dir | **left** — `hdiutil` costs 5–8s and blows the default test timeout |
| 11 | Case 2, macOS: DMG from the recovered app | **left** — same `hdiutil` cost |

`create-cli-tarball.sh` — all three **left**: `dist/dev3` missing, `dist/index.html` missing,
macOS `dist/tmux/tmux` missing. Each is an immediate `::error::` + exit with the fix command in the
message, no logic to get wrong, and each fires on the first line of a broken build rather than
deep inside a release.

**RESIDUAL, stated plainly rather than left silent:** five failure paths in the artifact script and
three in the CLI script remain unexercised — eight in total, and **two of the eight are left for
`hdiutil` cost rather than for principle.** A cap that is decided is fine; a cap that is silent
reads as coverage. With three of eleven branches proven dead, the remaining five in the artifact
script carry a *measured* prior, not a theoretical one.

**And that prior is high enough to be a prediction rather than a chore.** Twice in one day, adding a
real assertion to this script uncovered something five months old. That is not luck twice; it is a
property of the file — its failure-only paths have never been exercised, so any genuine assertion
has a high chance of finding a corpse. Whoever picks up the remaining five should expect to find
bugs, not to confirm correctness. If a release ever fails inside one of them,
that measurement is why nobody gets to be surprised.

**The test for one of them was host-dependent, and it failed naming the wrong cause.** It
symlinked the repo's `node_modules` and drove the script as `macos/arm64`, so it needed
`dist-macos-arm64/zig-zstd` — installed on the author's macOS arm64 machine, absent on a Linux CI
runner. It passed locally and failed on CI reporting the `version.json` notice missing, when the
real cause was that the compress step never ran at all. Had that failure looked like a flake it
would have been re-run and the test would have shipped, proving nothing anywhere it mattered.

The repair is a **shim that enforces the real binary's contract** — it refuses positional arguments
exactly as `zig-zstd` does — not a platform skip. A skip would have converted a broken test into an
absent one: green on the runner, and absence reading as success. Mutation-proved both directions:
revert the call site to the positional form and the `InvalidArgs` assertion goes red with the right
message; restore it and the file is 7/7. **A test that depends on what happens to be installed is
not a test of the script; it is a test of the machine.** That matters specifically for these release
scripts, whose whole job is to run on a runner rather than on a laptop.

The tests covering the two revived branches deliberately tar a directory that is *not* the `.app`
bundle, which exercises path 5 at the same time and skips DMG creation, so they run in ~1.4s
instead of timing out.

## 8. A stacked pull request gets NO CI here, and an empty checks list is not a pass

`build.yml` triggers on `pull_request: branches: [main]`. A PR whose base is another branch — the
second half of a stacked pair — therefore fires **no workflow at all**, and `gh pr checks` answers
*"no checks reported"*. That reads as harmless to anyone skimming, which is the same defect as every
other one in this record: **absence looking like success.** A local `bun run test` is not a
substitute — it cannot see the sharded matrix, the two terminal-e2e legs, or the trivy scan.

The `pull_request` trigger was deliberately **not** widened. That is a CI-policy change whose cost
lands on every stacked branch in the repo, and the gap is bounded: a stacked PR here retargets to
`main` the moment its parent merges, and it gets the full suite before anyone can merge it.

**That reasoning has an expiry condition, stated so it does not become folklore.** If this repo ever
grows stacks that live for days, or a stacked PR is ever merged while still targeting a branch, the
bound is gone and the trigger question comes back. Until then, the mitigation is a warning line in
the stacked PR's own body naming which checks are unrun.

## 9. Coverage caps: discovery by breakage is luck, and the numbers that prove it

The extract broke two assertions scoped to `release.yml` alone — the publisher enumeration in
`workflow-windows-proof.test.ts` and the lockfile check in `workflow-lockfiles.test.ts`. Both were
found by tripping over them. A deliberate sweep of every file that reads `.github/workflows` as
data then found a **third**, in `workflow-pipefail.test.ts`, which this change **cannot** break:
`| tee` appears four times in `build.yml` and in no other workflow, including `release.yml` and
both new reusable files.

**Three caps existed; two were found by breakage, one only by the sweep.** That is the evidence
that discovery-by-breakage is luck.

The strongest argument against re-capping is a measurement. Hardcoding the pipefail list back to a
single file takes that suite from **nine tests to two and still passes green** — nothing fails,
nothing warns, 78% of the coverage is gone, and the only signal is a test count nobody reads.
Anyone wanting to "simplify" the derive has to meet those numbers first; they are repeated in a
comment on the derive itself.

## 10. Risks

- A reusable workflow's inputs are its whole contract. A caller that forgets `publish` fails at
  parse time (required, no default), but a caller that passes the raw string output type-checks and
  publishes; only the call-site test catches that.
- The `linux-arm64` GUI-bundle step now fails instead of warning. A run that used to go green with
  an annotation nobody read will now go red. That is the intent, and it is a behaviour change on
  the release path.
- The DMG step's disk margin is unmeasured (section 5).

## 11. Alternatives considered

- **One reusable workflow for all four platforms** — rejected; see section 2.
- **A required enum input to switch step order** — rejected; a declared conditional is still a
  conditional, and unifying the order removes the branch entirely.
- **Keeping the builds inline and adding a fifth and sixth copy for unstable** — rejected: the
  duplication is what makes a per-step guard easy to lose, and the guard is the one line that
  publishes to real users.
- **Proving the extract with a green test suite** — rejected on principle: a wrongly-skipped step
  produces artifacts and goes green. Hence the dry runs.
- **Comparing baseline against extract only** — rejected after it failed in practice; see
  section 5.
