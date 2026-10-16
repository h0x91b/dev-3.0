# Initialize Git in place through a private index

## Context
Issue #1976: Add Project refused a folder with files but no Git repository, and the only way out was `git init && git add -A && git commit` in a terminal. A blanket `git add -A` would commit whatever sits in that folder, `.env` files and build output included, so it cannot be what the app does on the user's behalf.

## Decision
`src/bun/git-init-in-place.ts` builds the first commit with plumbing: `hash-object` for dev3's `.dev3/README.md` placeholder, `update-index` + `write-tree` against a private `GIT_INDEX_FILE`, `commit-tree`, then `update-ref <HEAD's branch> <sha> ""`. The user's index, files and hooks are never involved, so nothing of theirs is staged or committed, and an existing `.dev3/README.md` is never rewritten (the commit is then empty). The empty old value makes `update-ref` refuse if a branch appeared meanwhile. `probeGitInit` refuses repos with history, folders inside a parent repo, git dirs, unreadable `.git` and dubious ownership. A commit-less repo at the folder root (a failed earlier attempt, or the user's own `git init`) is offered the same first commit, which also makes every partial failure retryable without deleting anything. A missing identity retries under `dev-3.0 <dev3@localhost>` for that commit only, as `sandbox-project.ts` already does. The empty-folder flow goes through the same routine without a confirmation.

## Risks
Hooks do not run for this commit, deliberately. The placeholder is recorded in the real index afterwards; if that step fails (an `index.lock`), `git status` shows it as deleted until the next `git reset`, which is logged rather than fatal.

## Alternatives considered
`git add -- .dev3/README.md && git commit` is fine in a fresh repo but commits whatever the user had already staged in a commit-less one. `git commit --allow-empty` has the same problem. Rolling back a half-initialized `.git` on failure was rejected: deleting anything in the user's folder is worse than a retryable state.
