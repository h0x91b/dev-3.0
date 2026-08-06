## Context

We needed an inline multi-file git diff viewer in the task pane with unified/split switching, whitespace markers, and support for branch, uncommitted, and unpushed diffs. The chosen library exposes a strong per-file React viewer, but its git API is centered on individual file hunks and its whitespace transform hooks are global.

## Investigation

We checked the `@git-diff-view/react` and `@git-diff-view/file` packages directly from the installed sources. The React viewer is easiest to use when each file is rendered independently, while the global transform API is risky for whitespace visualization because it affects every viewer instance in the process.

## Decision

We fetch changed files from git in `src/bun/git.ts#getTaskDiff`, load old/new file contents from refs or the worktree, and render each file through `generateDiffFile` in `src/mainview/components/TaskDiffViewer.tsx`. Whitespace symbols are applied by transforming the displayed file contents before generating the diff, so the feature stays local to the inline viewer instead of mutating global library state.

## Risks

File-mode rendering may not match git's exact hunk boundaries for every edge case, especially around rename heuristics or unusual whitespace-only diffs. Very large or binary files are skipped on purpose, so the viewer can show fewer files than the raw git diff.

## Alternatives considered

We rejected feeding one raw multi-file git patch into a single `DiffFile`, because the library is structured around one file per instance and the UX would be harder to control. We also rejected the library's global transform hooks for whitespace markers, because they would couple one viewer's toggle to all other viewers.
