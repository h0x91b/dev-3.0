# Transcripts in a shared folder are scoped to the task's own sessions

## Context

Every transcript reader finds a task's conversations by its working folder (`transcriptFilesForWorktree`). A worktree belongs to one task, so that was exact. A project with its git workflow off, or an Operations task in a folder the user chose (Quick-shell runs in `~`), shares the folder with every other task and with the user's own sessions. The handoff then retold whichever transcript was newest, the Conversation tab listed the neighbours' sessions, and the completion archive copied all of them into this task's dumps, from where conversation search attributed them to it.

## Decision

`src/bun/task-sessions.ts` keeps `agent-sessions.json` in the task container: every session id a hook reports (`task.agentHook` for Codex, omp and Copilot, `task.promptSubmitted` for Claude). The hooks fire on each new session, so `/clear` and compaction are covered. `taskSessionIds` returns those ids plus the ids on the task's panes, or null for a folder dev3 owns. `transcriptInSessions` (`src/bun/conversation-parse.ts`) matches the id every store puts in the file name. The handoff preview and render, `readTaskConversation` and `dumpTerminalTaskConversations` apply it. The handoff preview cache is keyed by task as well as folder.

## Risks

- A store whose file names carry no session id (Gemini today) shows nothing in a shared folder. That is the safe side: wrong attribution is worse than none.
- A session whose hooks never reached the app (app down for its whole life) is missing unless its id is on a pane.
- The file is new state under the task container, written in place. Older versions ignore it.

## Alternatives considered

- Filtering by time window of the task's run: overlapping tasks are the whole problem.
- A field on the task in `tasks.json`: every hook would rewrite the board file under its lock; one small file per task costs nothing.
