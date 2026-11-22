> Partly superseded on 2026-11-21 by `decisions/2026/11/21/task-header-status-items.md`: the status bar is split too, so the legacy-cluster mechanism is gone.

# Task header: the Git bar as individual built-in items

## Context

Step 3.4 of the GUI-on-Cordis migration splits the Git bar's legacy cluster (`task-header-slot-frame`) into one item per control. `TaskGitActions` called `useTaskBranchStatus` once and every button read that one instance; the header ran a second, inert-on-desktop instance for the narrow layout and received the desktop one's status through a render callback, because the Context bar's diff badge needs it too.

## Decision

`src/mainview/task-header/builtin-git.tsx` registers six items in the `git` region (ops-repo, workflow-off, branch, changes, pr-status, actions) and seven in the `git.actions` group (commit, rebase, push, pr, auto-pr, merge, refresh), all `builtin:git.*`, from the one required built-in plugin. `TaskHeader` owns the single `useTaskBranchStatus` instance (enabled whenever the task has a Git bar) and puts it, the layout folds (`compact`, `tight`, `collapsed`) and `onOpenInlineDiff` into the header scope context (`useTaskHeaderInternals`); the diff badge reads the same instance, so the render callback and the second instance are gone. Each item draws its bar form or its sheet row (`useTaskHeaderSurface`); `TaskGitActionsSheet` is now only the sheet's Git section frame around `<TaskHeaderRegionItems region="git" surface="sheet">`, and the narrow summary bar draws no Git items, as before. `TaskGitActions.tsx` is deleted; `TaskOpsRepoBar` keeps only the attach/repo chip.

The actions keep their own 4px row inside the bar's 6px gap: the `actions` item draws the `|` divider and the old group span, and inside it a second `<TaskHeaderRegionItems region="git.actions">`, so every action is still its own item with its own error boundary. A flat list with a `-2px` margin per action was tried first and failed the pixel diff: where the root font size scales (850px task route), gap and margin round to 1/64px separately, shifting icons by a sub-pixel.

"Action items" are component items built on shared `GitBarButton` / `GitSheetRow` primitives, not a declarative `action` descriptor: the bar and sheet forms of one action differ in label, disabled rule and reason text today, and freezing a descriptor is the palette work of 3.7 / Phase 4. Built-ins reading internals (`useTaskBranchStatus`, `api`) is the recorded tech debt from the user's 2026-11-21 decisions.

## Risks

Ten items re-render on every status change of the shared instance; they are cheap and the old cluster re-rendered as a whole. Collapsing or expanding the header no longer refetches the branch status, because the hook stays mounted: intended, since the 15s poll and the sheet-open refresh remain. `git.actions` is a group inside a region: the 3.6 user layout must treat it as part of the Git bar when it reorders or hides git items.

## Alternatives considered

A flat region with negative margins: see above, not pixel-identical. One `useTaskBranchStatus` per item: ten pollers and ten merge prompts per header. Copying the status into each item's props: the brief rules out copying cross-bar state.
