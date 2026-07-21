# 149 — In-task Bug Hunters Skip Task Lifecycle Duties

## Context

In-task Bug Hunters share the originating task's worktree and task id with its main agent. The common dev3 session-start protocol therefore prompted hunters to rewrite the branch, title, overview, labels, and other task metadata even though the hunt itself is advertised as read-only.

## Investigation

The in-task launch prompt already limits code inspection and routes findings through `dev3 note add`, but the shared lifecycle prompt had no Bug Hunter exception. Separately, [`spawnSingleBugHunterPane`](../src/bun/rpc-handlers/tmux-pty.ts) stored the hunter's agent configuration both on its pane and on the originating task, replacing the primary agent's assignment.

## Decision

Add an in-task Bug Hunter isolation rule before the shared session-start checklist, repeat it in the Bug Hunter skill, and front-load it in [`buildBugHunterPrompt`](../src/bun/rpc-handlers/tmux-pty.ts). Store hunter attribution only on its `sessionState.panes` entry; the originating task keeps the primary agent and configuration.

## Risks

The metadata safeguard remains prompt-based rather than a capability boundary, and native hooks still observe the shared task. If cooperative isolation proves insufficient, reopen the issue and evaluate scoped capabilities or observer roles separately.

## Alternatives considered

Removing all dev3 access was rejected because notes are the handoff channel from hidden hunter panes. Disabling hooks was rejected because it has a much larger lifecycle blast radius; scoped CLI capabilities and observer roles remain deferred unless the prompt safeguard fails in practice.
