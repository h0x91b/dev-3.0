# Forget worktree trust when the worktree is removed

## Context

Each task launch registers its worktree as trusted in the agent CLI's own config
so the agent skips its "do you trust this folder?" dialog: `ensureGeminiTrust`
writes `~/.gemini/trustedFolders.json`, and `ensureClaudeTrust` /
`ensureCodexTrust` do the same for their files. Worktrees are disposable; none of
these had a removal counterpart, so the files accumulate one dead entry per task
forever. Measured on one machine: 12 of 13 Gemini entries were dev3 worktrees, 9
of them already deleted.

## Decision

`src/bun/worktree-trust.ts` owns both halves for Gemini:
`forgetWorktreeTrust(path)` (called from the lifecycle executor's
`removeWorktree` and `removeTaskWorkspace` effects) and
`sweepStaleWorktreeTrust()` (called once at startup from `src/bun/index.ts`).
The module is deliberately the shared "forget this worktree everywhere" seam —
Claude (`~/.claude.json`) and Codex (`~/.codex/config.toml`) pruning belongs in
these two functions, not in parallel copies.

Two guards make it safe: a key is only touched when it is under
`${DEV3_HOME}/worktrees` (compared case- and separator-insensitively, because
older entries were written with different casing), and the sweep additionally
requires the directory to be gone. Unparsable JSON fails closed — logged, never
rewritten. `GEMINI_TRUSTED_FOLDERS` now lives here and `agents.ts` imports it, so
writer and pruner cannot drift apart.

## Risks

Pruning a still-wanted entry would re-show the trust dialog once — harmless, and
both guards must fail together for it to happen. A worktree removed while the app
is closed is caught by the next startup sweep instead.

## Alternatives considered

Pruning inside `git.removeWorktree` — rejected: it would make the git layer
depend on agent config, and it misses virtual-project workspaces that never go
through git. A dedicated lifecycle effect — rejected: it would touch the
transition table in several places for a step that is unconditional whenever a
workspace is destroyed.
