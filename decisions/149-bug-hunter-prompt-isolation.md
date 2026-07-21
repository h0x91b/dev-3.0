# 149 — In-task Bug Hunters Skip Task Lifecycle Duties

## Context

In-task Bug Hunters share the originating task's worktree and task id with its main agent. The common dev3 session-start protocol therefore prompted hunters to rewrite the branch, title, overview, labels, and other task metadata even though the hunt itself is advertised as read-only.

## Investigation

The in-task launch prompt already limits code inspection and routes findings through `dev3 note add`, but the shared lifecycle prompt had no Bug Hunter exception. Separately, native lifecycle hooks still observe the shared task, and `spawnSingleBugHunterPane` currently records the hunter's agent configuration on that task.

## Decision

Add an in-task Bug Hunter isolation rule before the shared session-start checklist, repeat it in the Bug Hunter skill, and front-load it in `buildBugHunterPrompt`. Hunters may read dev3 state and add confirmed `[bug-hunt]` notes, but must leave the branch and existing task metadata/lifecycle to the main agent.

## Risks

This is a prompt-level safeguard, so it prevents cooperative agent actions but is not a capability boundary. Native hooks can still change status, and the spawn handler still changes task-level agent attribution; those require a later observer-role mechanism outside the prompt.

## Alternatives considered

Removing all dev3 access was rejected because notes are the handoff channel from hidden hunter panes. Disabling hooks or introducing scoped CLI capabilities in this change was deferred because the user explicitly chose the smallest prompt-first mitigation while the correct observer boundary is designed separately.
