# 179 — The completion dialog opens instantly and checks unsaved work locally

## Context

The task card's quick-complete ✓ funnels into `confirmTaskCompletion`, which awaited
`getBranchStatus` *before* rendering anything. On a real task that took ~5 seconds with no
feedback at all: the click looked dead and the dialog appeared long after the user had moved on.

## Investigation

`getBranchStatusImpl` (`src/bun/rpc-handlers/git-operations.ts`) is deliberately heavy — up to
three `git fetch origin` calls, `gh pr list`, `isContentMergedInto`, `isPullRequestMerged`,
`saveDiffSnapshot` — and it queues behind a 4-wide cross-task semaphore shared with every
panel's 15s poll. Correct for a status panel, unusable in front of a modal. A first attempt kept
the heavy call and gated the dialog's confirm button for up to 4s; browser QA showed the gate
routinely timing out into "Could not check the branch", i.e. the user lost the warning *and*
waited. Measured after the fix: dialog on screen 3ms after the click, check settled at 73ms.

## Decision

Two parts.

1. **New local-only RPC `getUnsavedWork`** (`git-operations.ts`, type `UnsavedWork` in
   `src/shared/types.ts`): `getUncommittedChanges` + `getUnpushedCount` + `getBranchStatus`
   against the last known `origin/<base>`. No fetch, no `gh`, no semaphore. It deliberately
   answers only "what would deleting this worktree destroy", which is by definition local — so
   it omits the "pushed but not merged" line, whose commits are already safe on the remote.
2. **`ConfirmOptions.deferred`** (`src/mainview/confirm.tsx`): a second message block that
   arrives after the dialog is painted — muted `pending` line with a spinner, replaced by the
   result, removed when it resolves `null`. `gateConfirm` keeps the confirm button disabled
   until it settles (capped by `gateTimeoutMs`, default 4s, falling back to `unknown` text), so
   a data-loss warning can never be clicked past. Cancel always stays live.

`confirmTaskCompletion` uses this only on the `alwaysConfirm` (one-click) path; the menu path
still awaits the full remote-aware `getBranchStatus` and prompts only when it has something to
say. The ✓ itself also flips to a disabled spinner on click, so the click is acknowledged on the
same tick regardless of the dialog.

## Risks

- `ahead` is computed against a possibly stale `origin/<base>`, so the "never pushed" count can
  over-report right after an out-of-band push. Over-warning on a destructive confirmation is the
  safe direction; under-warning is not.
- Two RPCs now answer overlapping questions. `getUnsavedWork` is intentionally narrower and its
  doc comment says when to use which; drifting them apart is the maintenance cost.
- The gate can still time out on a pathologically slow local git, which shows the honest
  "could not check" text and enables confirm.

## Alternatives considered

- **Keep the heavy call, just gate longer.** Rejected: the wait is the complaint.
- **No gate, warnings whenever they land.** Rejected: a fast clicker deletes uncommitted work
  without ever seeing the warning.
- **`skipFetch` flag on `getBranchStatus`.** Rejected: the flag would silently change the meaning
  of `mergedByContent`/`ahead` for every existing caller; a separate narrow RPC cannot.
