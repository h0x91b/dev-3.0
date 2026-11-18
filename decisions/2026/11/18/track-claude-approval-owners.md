# Track Claude approval owners

## Context
The initial background-tool filter prevented unrelated work from clearing a parent's approval, but also ignored the waiting background agent's own completion. Maintainer review of PR #2317 identified that stuck status and the missing offline tolerance around the new PreToolUse command.

## Investigation
Claude includes session_id and agent_id in permission and tool hooks. PermissionRequest lacks tool_use_id, so it cannot unambiguously identify a pending call among parallel tools in the same conversation. The shared installed CLI can predate the task's hook file: an unknown hook exits 2 during socket discovery when the app is offline, and Claude treats that code as a blocking PreToolUse error.

## Decision
ClaudeApprovalState tracks an in-memory set of waiting owners per task, keyed by conversation and optional background agent, and remembers the working or AI review lane to restore. applyClaudeHookStatus serializes owner updates and guarded status moves; only the waiting owner's activity clears its wait, and other waits remain visible. PreToolUse, permission notifications, failed tools, SubagentStop and TeammateIdle report through handleClaudePreTool; successful tools report through handleClaudePostTool without handing background agents the parent's mailbox. New prompts clear their own wait; SessionEnd cleans up SDK sessions even without a pane. Background work reopening a stopped parent restores its review lane after the final worker stops or becomes idle. Both adapters use one parser and ignore malformed payloads.

## Risks
Ownership is per agent, not per tool: a parallel sibling tool in the same parent can still clear its wait, explicitly covered by a regression test. State is local to the running app, so after a restart background work conservatively leaves an unowned Has Questions card alone. POSIX commands tolerate only exit 2 with a shell guard; Windows requests the existing --tolerate-app-offline flag because its hook runner has no POSIX shell. An older Windows CLI that predates that flag cannot provide the same guarantee; an app/CLI version mismatch may still lose status reporting until the installed CLI is updated.

## Alternatives considered
Ignoring all background tool hooks loses both their approval resumes and their activity after the parent stops. A single task-wide background-wait flag lets one background agent clear another's question. Terminal-text matching and persistent approval state add complexity without supplying the missing stable tool identity.
