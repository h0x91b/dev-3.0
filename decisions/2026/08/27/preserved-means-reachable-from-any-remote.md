# "Preserved" means reachable from any remote ref, not present under `origin/<branch>`

## Context

The completion dialog warns "N commits never pushed — will be lost" before a worktree is
destroyed. Its number came from `getUnpushedCount`, which asks one question: does
`origin/<current-branch-name>` exist? A branch pushed under a different name
(`git push origin HEAD:feature/example`) has no such ref, so a branch whose every commit sits
on the remote was reported as about to be lost (issue #1545, reported by @vit-pavlenko).

A false loss warning on the completion path is worse than a wrong number: it trains the user to
click through the one warning that must never be ignored, and a genuinely unpushed branch looks
identical to this false one.

## Investigation

Reproduced exactly as the issue describes. With `git push origin HEAD:feature/example`:
`origin/dev3/task-1` does not resolve, no upstream is configured (no `-u`), and
`git rev-list --count HEAD --not --remotes` is `0` — every commit is on the remote. So consulting
the configured upstream alone does **not** fix the reported case; reachability does, and it also
covers the `-u` variant, because an upstream that was pushed to is itself a remote ref.

`git rev-list --count HEAD --not --remotes` cannot be folded into `getUnpushedCount` itself: on a
brand-new task branch with no commits of its own it is `0`, which would flip that function's `-1`
sentinel to `0` for merge detection (`src/bun/lifecycle/activities.ts`) and send a
just-created branch into the content-merge path, where it reads as merged.

## Decision

`unpushed` on `BranchStatus`/`UnsavedWork` now means "commits that exist on no remote", and is
produced by a new `getUnpreservedCount` (`src/bun/git.ts`), used by `getBranchStatus` and
`getUnsavedWork` (`src/bun/rpc-handlers/git-operations.ts`) — the two feeds of the completion
dialog. It delegates to `getUnpushedCount` whenever `origin/<branch>` exists, and otherwise
returns `0` only when HEAD is reachable from some remote ref; anything else keeps `-1`.

`getUnpushedCount` is unchanged and keeps both remaining callers — merge detection and PR polling
(`pollTaskPrStatus`) — because they deliberately ask the name-based question: `gh pr list --head
<branch>` and the content-merge guard are both about this branch's own name.

## Risks

A branch pushed under another name that then gained more local commits still reports `-1`, so the
dialog names `ahead` and overstates how many commits are actually at risk. That is the safe
direction — loud, never silent — and it is the only case where the wording ("never pushed") is
still loose. A repo with no remote refs at all is untouched: the reachability count is its whole
history, which is not `0`, so it keeps `-1` and the dialog keeps using `ahead`.

## Alternatives considered

Always counting via `--not --remotes` and dropping the `-1` sentinel gives an exact number in
every case, but changes the message for the ordinary never-pushed branch and makes the
"pushed but not merged" line fire for work that was never pushed — new false statements in
exchange for precision nobody asked for. Fixing only the wording ("the branch *name* was not
pushed") leaves the count wrong and the warning still loud on preserved work.
