# Recorded git transcripts for the diff suites

## Context

`src/bun/__tests__/git-test-helpers.ts` gives every git suite a real repository:
`mkdtempSync` into the temp dir, a real `git init --bare`, a real clone, real
commits. On top of that, the suites mock `../spawn` with `createSpawnMock()`, which
forwards to Node's `child_process` — so the *code under test* also runs real git.

Measured on one backend run of `bun run test` (the exclusions that command already
applies, so `git-worktree` and `git-merge-detection` are not in it): **341 real
process spawns, of which 225 (66%) originate in `git-test-helpers.ts`** — 124 from
the fixture and 99 from the code under test. Every one of them competes with the
other two vitest processes for the same cores, which is how the suite came to fail
under load with zero `AssertionError`: timeouts and collect-time errors only, on a
failing set that shifts between runs.

## Investigation

Counted, not estimated, with a throwaway vitest config that patched the
`child_process` CJS exports and source-transformed every `mkdtemp` call site.
Two terms in the fixture were pure waste:

| Term | Cost | Why |
|---|---|---|
| Template repo rebuilt per test **file** | 7 builds × 8 git processes | `_templateDir` is module state, and each vitest file gets its own module registry |
| `git remote set-url` per fixture | 23 processes | It rewrites one line of `.git/config`, which is a plain file |

The remaining 99 are the code under test asking real git real questions. Those are
only removable by replacing git's answers — which is the risky half, because git's
output is the input to every parser in `git.ts`.

## Decision

Three changes, in `src/bun/__tests__/`:

1. **`git-replay.ts` (new)** — record/replay for git. A suite records real git once
   into `fixtures/<suite>/<scenario>.json` (opt-in, `DEV3_GIT_RECORD=1`) and
   afterwards replays it. A response is keyed on the **exact argv plus cwd plus
   stdin**; a miss throws and logs, naming the command and telling the reader to
   re-record. Output is stored base64 because `-z` lists and `cat-file --batch` are
   not valid UTF-8.
2. **`git-diff-recent.test.ts`** converted to it. Its subject is *our* `HEAD~N`
   clamp, not git's behaviour. 85 real processes and 7 temp dirs → 0; 6.91 s of test
   time → 18 ms. The recording recipe stays in the file, so regenerating is a
   command, not archaeology.
3. **`git-test-helpers.ts`** keeps real git for the suites that need it, but builds
   the template **once per run** (shared across workers behind an atomic `mkdir`
   lock) and repoints the clone's remote by editing `.git/config`.

Suites whose subject *is* the real thing were deliberately left alone:
`git-diff-rename` (git's own rename-similarity threshold), `create-release-artifacts`
and `ci-bun-install-retry` (the subject is a shell script), `cli-instance-routing`
(process-level routing across real sockets).

## Risks

- **A transcript can drift from reality.** It is recorded once and then trusted; if
  the installed git changes its output format, the fixture keeps the old shape and
  the suite stays green on an answer git no longer gives. Mitigated only partly, by
  the sibling suites (`git-diff-batch`, `git-diff-no-remote`,
  `git-unicode-filenames`, `git-diff-rename`) still running `getTaskDiff` against
  real git.
- **Over-specified argv.** Keying on the exact argv means a harmless reordering of
  flags fails the suite. That is the cost of the teeth; the failure message says to
  re-record.
- **The shared template is a new cross-worker dependency.** A crashed build leaves a
  lock directory; the next run removes a partial tree and rebuilds. The template is
  never deleted by a worker exiting, only by `cleanupTestIsolation` at the end of
  the run.

## Alternatives considered

- **Hand-written `mockResolvedValue` per git call.** Rejected: invented output lets
  a parser bug pass, and the mock would keep passing after the command changed.
- **Keep real git, share one repository across the tests in a file** (reset with
  `git reset --hard` between tests). Cheaper to write and keeps everything real, but
  it only divides the cost by the number of tests in a file instead of removing it,
  and a leaked state between tests is a new class of flake.
- **Convert every git suite.** Rejected: it would leave nothing exercising
  `getTaskDiff` against real git, and `git-diff-rename`'s whole subject is a git
  heuristic. Recorded transcripts are for suites whose subject is our own logic.
