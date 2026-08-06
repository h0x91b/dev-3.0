# 189 — Verify a resume session id against the agent's transcripts

## Context

A long-running task could not be resumed after a machine restart: the agent pane
launched `claude --resume 125a4c8c-…`, printed `No conversation found with
session ID: 125a4c8c-…`, and exited 1. The pane died next to dev3's virtual
shell, so the task looked destroyed — while the conversation itself was intact on
disk under a *different* file name.

dev3 mints a UUID on fresh launch, passes it as `--session-id`, and persists it
as the task's resume pointer (`sessionState.panes[].sessionId`). That pointer is
written optimistically, before the agent has materialized a transcript for it.

## Investigation

The surviving transcript was `~/.claude/projects/<encoded-cwd>/1160218f-….jsonl`,
covering the task's whole life. Two id fields inside it disagreed: every line's
`sessionId` was `1160218f` (the file's own id), while 934 lines carried
`session_id` = `125a4c8c` — the *live process* id dev3 assigned. So the process
really ran under our id but appended to an earlier conversation's file (a
`~/.claude/session-env/125a4c8c-…/` dir existed; a transcript never did).

The task's hourly backups pinned the moment it broke: the stored pointer was
`1160218f` at `2026-07-26T20Z` and `125a4c8c` at `21Z`. Every resume after that
was doomed. A sweep of all boards found 3 of 58 pointers stale the same way.

## Decision

Check the stored id against what is actually on disk before spending it on
`--resume`. `src/bun/agent-transcripts.ts` (`resolveResumableSessionId`) returns
the stored id when its transcript exists, the **newest transcript for that
worktree** when it does not, and null (→ the agent's own `--continue`) when the
store is empty. `resumeTask` in `src/bun/rpc-handlers/tmux-pty.ts` routes both
the main pane and every extra pane through it, and `launchTaskPty`'s existing
`sessionState` write persists the healed id — so a stale pointer repairs itself
on first use.

Transcript layout is adapter knowledge: `AgentAdapter.transcriptStore` returns
`{ dir, ext }` (pure, no fs) and only Claude implements it, because only Claude's
store is filename-keyed by the resumable id.

## Risks

- **Wrong conversation on substitution.** If several transcripts exist for one
  worktree we pick the newest by mtime, which may not be the one the user meant.
  Accepted: the alternative is a dead pane, and mtime order matches "what I was
  last working on" in practice.
- **Unverifiable stores stay unverified.** Codex and Gemini key transcripts on a
  cwd header *inside* the file, so their ids pass through untouched. Deliberate:
  the resolver never downgrades a resume it cannot check.
- **Optimistic persist remains.** A fresh launch still records the id before a
  transcript exists, so dead pointers can still be written — they now heal on
  read instead of failing.

## Alternatives considered

- **Persist the id from the transcript filename instead of the runtime id** —
  correct at the source, but requires watching the store after launch (the file
  does not exist until the first message) for no additional coverage: healing on
  resume already handles every way the pointer can rot.
- **Always `--continue`, never `--resume <id>`** — loses targeted resume, which
  variant isolation and multi-pane tasks depend on.
- **Surface the failure in the UI and let the user pick** — a modal for a
  question dev3 can answer itself; the substitution is logged instead.
