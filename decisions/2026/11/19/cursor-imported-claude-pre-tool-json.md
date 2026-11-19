# Cursor imports Claude pre-tool hooks

## Context

Cursor imports `.claude/settings.local.json` by default. Switching a task from Claude Code to Cursor therefore runs dev3's Claude hooks even though Cursor's own dev3 hooks only collect usage.

## Investigation

The reported failure names the generated `task move --status in-progress` command. That command prints human-readable output, which Cursor rejects before every tool call. Cursor documents the import and JSON response requirements at https://cursor.com/docs/reference/third-party-hooks and https://cursor.com/docs/hooks.

## Decision

`buildClaudeHooks` uses `dev3 hook claude-pre-tool`, which keeps the existing review guard and always returns JSON. The handler returns Cursor's native permission response only when the payload carries `cursor_version`; Claude receives an empty object so the status hook does not override its permission checks. Cursor launch refreshes only inherited dev3 pre-tool status commands, preserving other hooks and settings.

## Risks

Cursor detection depends on its documented `cursor_version` field. Running Cursor sessions need a relaunch through the updated app to refresh legacy commands; shared settings behind symlinks remain untouched.

## Alternatives considered

Removing Claude hooks would disrupt other Claude panes sharing the task. Returning a Claude `permissionDecision: allow` would override normal permission prompts, and disabling third-party imports would disable user hooks too.
