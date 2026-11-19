Superseded on 2026-11-18 by `decisions/2026/11/18/track-claude-approval-owners.md`: track waiting owners instead of ignoring background tools, and tolerate older offline CLIs.

# Claude background tools preserve parent approval waits

## Context
A Claude conversation waiting on a security-hook approval could appear in Agent is Working while background subagents continued reading files. All agents in the conversation inherit the same task hooks.

## Investigation
Claude's [hooks reference](https://code.claude.com/docs/en/hooks#common-input-fields) identifies subagent and in-process teammate calls with `agent_id`. The plain PreToolUse move ignored that field, and `handleClaudePostTool` only used it to suppress mailbox delivery while still moving the task to in-progress; a regression test reproduces that request during a parent wait.

## Decision
`buildClaudeHooks` routes PreToolUse through `handleClaudePreTool` and PostToolUse through `handleClaudePostTool` on both platforms. Both adapters ignore tool calls carrying a nonempty `agent_id`; main-conversation calls retain the AI review guard and mailbox delivery. Notification hooks additionally observe `permission_prompt` and `elicitation_dialog`, without treating generic idle notifications as questions. Remove the unconditional PostToolUse fallback, which bypassed payload filtering.

## Risks
This addresses background tool hooks overwriting the parent wait, rather than tracking every concurrent tool's permission state. The installed CLI must include the new adapter before refreshed hooks use it; existing app and CLI update packaging supplies both together.

## Alternatives considered
Inferring an approval wait from terminal text would depend on Claude's rendering and security-hook wording. Tracking every outstanding approval needs stable tool identities across PermissionRequest and completion events; filtering explicit background identities fixes the demonstrated overwrite without new persistent state.
