# The agent protocol is rendered per task mode

## Context
The injected protocol assumed every task owns a git worktree on a `dev3/task-*` branch. A task in a project with the git workflow off runs in the shared project folder, so its agent was told to rename a branch it does not have, that the folder was its private isolation, and that `dev3 pr create` was the only way to open a PR. Agents mostly ignored those lines, at a reasoning cost every session.

## Decision
`src/shared/agent-skill-content.ts` keeps one template. The five mode-dependent pieces (workspace intro, the bug-hunter branch clause, the session-start checklist, branch naming, the completion section) take a `ProtocolMode`; `skillBodyFor` / `leanSkillBodyFor` render every family in both modes once at module load, because the PR section reads `process.platform` and the old constants were frozen at load too. `taskProtocolMode(project, task)` in `src/shared/types/project.ts` is the single predicate, used by the three launch sites (`CommandOptions.protocolMode`), `dev3 current` (`Protocol:` line) and the approval wording. Adapters declare a `skillFamily` instead of a lean body; each variant gets its own prompt file (`claude-shared-folder.md`, `claude-shared-folder-lean.md`).

## Risks
The installed `SKILL.md` files and the Copilot hook stay worktree-only: they are written per machine, not per task. A virtual (Operations) board keeps the worktree text, unlike the gitless coordinator brief. Generic mentions of "the worktree" in sections outside the five (notes, attention, panes) remain in the shared-folder text.

## Alternatives considered
Two hand-written bodies: they drift. String replacement on the worktree body: silent breakage when a sentence is reworded. A per-task prompt file: needless writes, since the text depends only on family, mode and platform.
