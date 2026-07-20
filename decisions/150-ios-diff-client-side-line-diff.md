# 150 — iOS diff renders a client-side line diff from full file contents

## Context
TestFlight build 8 feedback: the iOS Diff view showed every line of a modified file as a deletion
(a file summarized "+2 −0" rendered ~21 red lines). The backend (`git.ts` `buildTaskDiffFiles`, line
604) sends each file's full `oldContent`/`newContent` with `hunks: null` for **every** mode
(uncommitted/branch/unpushed/recent) — there is no per-file unified-diff hunk fetch. The iOS parser
(`TaskDiffModels.swift` `TaskDiffLineParser`) therefore always took its content fallback, which for a
modified file emitted the whole old file as deletions followed by the whole new file as additions.

## Investigation
`git show`/grep confirmed `hunks` is only ever the literal `null` in `src/bun` (git.ts:604), and two
backend tests pin that contract (`git-diff-batch.test.ts`, `git-diff-rename.test.ts`). The desktop web
renderer already diffs from old/new content on the client (`TaskDiffViewer.tsx`), so iOS was the only
client doing a naive whole-file replace. Emitting hunks from the backend would break the pinned
`hunks===null` contract and either bloat the payload (contents + hunks) or break the web/offline paths.

## Decision
Fix it on the **iOS client**. `TaskDiffLineParser.fallbackLines` now computes a real line diff for
modified files (`lineDiff`/`middleDiff` in `TaskDiffModels.swift`): trim the common prefix and suffix
(handles append/prepend/single-region edits in O(n)), then run an LCS over the differing middle, capped
at 1,000,000 cells so a huge full rewrite degrades to a plain delete-then-add instead of blowing the
review-screen budget. The `@@`-hunk parsing path is retained for any future hunk-bearing payload.

Related (issues I/J): because the diff is now fully client-renderable from cached content, a
stale-while-revalidate cache was added — `TaskDiffStore` surfaces the last payload for a
(mode, ref, count) key instantly and refreshes in the background, and a shared `TaskDiffCache` owned by
`CompanionAppRoot` outlives navigation so Review and Task Info → Changes reuse warm diffs. Cleared per
server.

## Risks
Client LCS is O(n·m) on the differing middle; the prefix/suffix trim keeps normal edits linear, and the
cell cap bounds pathological rewrites (covered by a 60-file perf test). The rendered del/add counts can
differ slightly from git's numstat summary badge when many similar-but-distinct lines change, because
the badge (backend numstat) and the body (client LCS) are computed separately — acceptable and
pre-existing separation.

## Alternatives considered
- **Backend emits unified hunks:** more "correct" but breaks the pinned null-hunks contract, grows the
  payload, and doesn't help offline rendering. Rejected.
- **Keep contents, diff on a background thread only:** unnecessary — prefix/suffix trim makes the common
  case cheap enough on the main actor within the existing budget.
