# Fetch the zsh prompt's git state asynchronously

## Context
`_dev3_precmd` ran `GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch` synchronously. With optional locks off, git never writes a refreshed index back, so once an index goes stale (checkout, rebase, mass touch) every prompt rehashes the tree: 1.5–3 s per Enter on a 50k-file repo (h0x91b/dev-3.0#2288).

## Decision
In `ZSH_PROMPT_ENGINE` (`src/bun/shell-init.ts`) git runs in a process substitution registered with `zle -F` (`_dev3_git_async` / `_dev3_git_done`), the same technique pure and zsh-async use. The previous result stays on screen; the handler parses the new one, refits the segments (`_dev3_fit`) and calls `zle .reset-prompt`, restoring `$?` first so `%?` still reflects the user's command. Only one job runs at a time; a prompt drawn meanwhile or a `cd` re-runs it once. Without a line editor (`zsh -c`, the style preview) the old synchronous path stays.

## Risks
A stale index still costs background CPU on every prompt until something refreshes it. The first prompt in a new pane shows no git segment until git finishes. The bash fallback prompt is still synchronous (bash has no `zle -F`).

## Alternatives considered
Dropping `GIT_OPTIONAL_LOCKS=0`, or an opportunistic `git update-index -q --refresh`: both take `index.lock` for the whole refresh, and agents committing in the same worktree would hit "index.lock exists". A timeout or `-uno`: still blocks, just less, and hides untracked counts.
