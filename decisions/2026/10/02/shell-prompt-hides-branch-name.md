# Shell prompt shows git counters, not the branch name

## Context
The dev3 shell-pane prompt (`src/bun/shell-init.ts`) was redesigned into a two-line segmented prompt. Task branches are long (`feat/dev3-…`) and the user found the name a waste of width; tmux panes are often under 40 columns.

## Investigation
Hiding the branch only when it equals the task's branch was considered, but `DEV3_BRANCH_NAME` in the tmux session environment is the branch at task launch and goes stale after the routine `git branch -m dev3/task-* …` rename (observed: env `dev3/task-9e1b3c5c`, actual `feat/dev3-…`).

## Decision
The prompt never prints the branch name; the git segment shows staged/modified/untracked/ahead/behind counters, `✓` when clean, and the short sha when HEAD is detached. Git state comes from one `GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch` per prompt so the prompt never takes `index.lock` away from agents in the same worktree. Narrow panes walk levels in `_dev3_build` (drop project → drop task → shorten then drop path → collapse then drop git counters → drop timer last) until the line fits `COLUMNS`.

## Risks
Being on an unexpected branch is no longer visible in the prompt. `git status` runs every prompt, which is slow in very large repos. bash gets no command timer (bash 3.2 on macOS has neither preexec nor a sub-second clock).

## Alternatives considered
Comparing against `DEV3_BRANCH_NAME` (stale, rejected); truncating the branch with `…` (still costs ~20 columns); a right-side `RPROMPT` (does not exist in bash, and collides with the user's own theme).
