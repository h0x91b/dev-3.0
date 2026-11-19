# Cursor drains held messages through postToolUse

## Context

Cursor Agent queues anything typed during a running turn as a "follow-up" and sends it only when the turn ends. A long autonomous Cursor turn therefore never saw peer `dev3 message`s: they piled up in the queue for hours (seen on a databricks board task). Claude avoids this through the PostToolUse hook mailbox.

## Investigation

Cursor documents `postToolUse` output `additional_context`, "injected into the conversation after the tool result". A throwaway project hook run with `agent -p` (2026.11.19-f005e9d) confirmed the CLI honours it: the text reached the model as a system reminder right after the tool result.

## Decision

`writeCursorUsageHooks` (`src/bun/cursor-usage-hooks.ts`) also merges a user-level `postToolUse` entry running `dev3 hook cursor-post-tool`, guarded on `DEV3_TASK_ID` so non-dev3 sessions spawn nothing. The CLI (`src/cli/commands/cursor-post-tool.ts`) calls `task.cursorPostToolUse`, which shares `drainHookMailbox` with Claude's handler but makes no status move, prints `{"additional_context": ...}` and acknowledges the claim. POSIX only: the mailbox is keyed to tmux panes.

## Risks

Injected context is invisible in the Cursor pane (no user-facing field, unlike Claude's `systemMessage`); the agent-traffic view still records the delivery. Cursor subagent tool calls cannot be told apart from the pane's own agent yet, so a subagent could take the mail.

## Alternatives considered

A worktree-local `.cursor/hooks.json` would touch the user's repo and need git excludes. Sending the queued follow-up as a "steer" keystroke depends on undocumented TUI keys and would type into whatever is focused.
