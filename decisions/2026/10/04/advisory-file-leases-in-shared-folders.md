# Advisory file leases in shared folders

## Context

With the git workflow off, every task of a project runs in the same folder (`decisions/2026/10/02/per-project-git-workflow-switch.md`), so two live agents can edit one file and the later write silently replaces the earlier. Claude's own read-before-write check catches only a file that changed since that agent read it, and the New Task warning reaches the human, not the agents.

## Investigation

Checked against Claude Code 2.1.289 with the real CLI and a stand-in app socket: a `PreToolUse` hook on the edit tools that prints `permissionDecision: "deny"` stops the edit, the file stays untouched, and the agent reads back the reason verbatim. The payload carries the absolute `tool_input.file_path` (`notebook_path` for notebooks).

## Decision

In a folder dev3 does not own, Claude's hooks gain a `PreToolUse` entry on `Edit|Write|MultiEdit|NotebookEdit` running `dev3 hook claude-claim` (`src/cli/commands/claude-claim.ts`). It asks `task.claimFile`, which calls `claimFileForTask` (`src/bun/file-leases.ts`) over the in-memory `FileLeaseTable` (`src/shared/file-leases.ts`). The first task to edit a file holds it until 10 minutes after its last edit there. Another task's edit is denied with a reason that names the holder and gives a ready `dev3 message --task seq:N` command, so the agents settle it between themselves. A holder that is To Do, completed or cancelled is dropped on the spot. Keys resolve symlinks and fold case on macOS and Windows.

## Risks

- Advisory only: Bash writes (`sed`, generators, `cat >`) are not claimed. The New Task warning stays as the backstop.
- Claude only. Codex has `PreToolUse` on `apply_patch`, but its deny contract was not verified here; Copilot and omp are follow-ups.
- Leases live in memory, so an app restart frees every file. That fails open, which is the intent.
- Two agents each holding a file the other wants wait at most the TTL.

## Alternatives considered

- One live task per folder: safe, but removes the parallel work that is the reason to run several agents.
- A copy of the folder per task merged back at the end: rebuilds worktrees without git and moves the conflict to merge time, onto the human.
- Leases persisted on disk: a crashed app would leave files locked; memory fails open.
