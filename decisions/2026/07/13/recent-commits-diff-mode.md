# 128 — "Recent commits" diff mode (Last Commit / Last N)

## Context

Issue #917 asks for a quick way to inspect an agent's latest commits on a task
branch — especially when the agent runs in `permissionMode: "auto"` and commits
autonomously. The existing diff modes (`branch`, `uncommitted`, `unpushed`) all
compare against the base branch or the working tree; none answers "what did the
last commit(s) change?". The issue also suggests a parameterised "last X
commits" selector as a possible improvement.

## Investigation

`TaskDiffMode = "branch" | "uncommitted" | "unpushed"` lives in
`src/shared/types.ts`; `git.getTaskDiff` (`src/bun/git.ts`) already accepts a
generic `compareRef`/`compareLabel` and builds `oldRef...HEAD` diffs, so an
arbitrary-ancestor diff is cheap. The mode selector is a row of toolbar buttons
in `TaskDiffViewer.tsx` (~L2741). Mode preference persists in localStorage
(`LS_DIFF_MODE_PREFERENCE`). There is **no** existing "list recent commits" RPC,
so a commit-subject dropdown would need new plumbing; fixed commit counts do not.
Because `HEAD~N` is always a direct first-parent ancestor of `HEAD`, two-dot
`HEAD~N..HEAD` and three-dot `HEAD~N...HEAD` are equivalent here — the merge-base
gymnastics the `branch` mode needs do not apply.

## Decision

Add a fourth diff mode `recent` (ubiquitous term: **"Recent commits" mode**,
user-facing label "Last commit" for N=1 / "Last N commits" for N>1).

- **Data model:** `TaskDiffMode += "recent"`; `getTaskDiff` gains an optional
  `count?: number`. The backend resolves `HEAD~min(count, branchCommitCount)..HEAD`,
  where `branchCommitCount` = commits since the merge-base with the base branch
  (reuse the `rev-list --count` path). It **clamps** to the branch's own commits —
  never reaching into base-branch history — and returns an honest `compareLabel`
  reflecting the effective count.
- **Comparison:** strictly committed changes (`HEAD~N..HEAD`); the working tree /
  uncommitted edits are excluded (that is what `uncommitted` mode is for).
- **Selector UI:** a split-button in the diff toolbar. Clicking the button body
  activates `recent` at the current N (default 1); the `▾` caret opens a popover
  with presets **1, 2, 3, 5, 10**; picking a preset sets N and activates the mode.
- **Persistence:** N is **not** persisted — it resets to 1 on every diff open
  (the primary case is "show the last commit"). Only the mode selection follows
  the existing localStorage preference.
- **Empty case:** when the branch has 0 own commits, reuse the existing
  "nothing to show" empty state (`renderState`); the button stays enabled.
- **Framing:** manual-only — a mode the user selects, exactly like the other
  three. No auto-open and no "new commits" badge.
- `DEFAULT_DIFF_MODE` stays `uncommitted`; `recent` mode skips the `origin` fetch
  that other non-uncommitted modes do, since `HEAD~N` and the local merge-base
  are purely local.

## Risks

- Clamp semantics can surprise: picking "10" on a 3-commit branch shows 3 and
  relabels to "Last 3 commits". Mitigated by the honest label.
- `HEAD~N` follows first parent, so on branches with merge commits "last N"
  counts first-parent depth — acceptable and matches `git log` intuition.
- A fourth mode plus a selector widens an already-dense toolbar; the caret/popover
  shape (over inline chips) was chosen partly to bound width, incl. narrow/mobile.

## Alternatives considered

- **Reuse `compareRef="HEAD~N"`** through the generic branch path instead of a
  typed `count` — rejected: clamping and the honest label need the merge-base
  commit count, which the frontend does not have; a typed `count` keeps the logic
  server-side and testable.
- **Commit-subject dropdown** (pick "diff since <commit>") — richer but needs a
  new `listCommits` RPC; deferred as a possible follow-up.
- **HEAD~N vs working tree** — rejected: mixes semantics with `uncommitted` mode.
- **Persist N / grey-out over-large presets / clamp to repo root / auto-open on
  agent commit** — all rejected in the design grilling for the reasons above
  (surprise, base-branch noise, or scope creep beyond "quick inspection").
