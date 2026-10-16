# Refuse a launch whose harness binary is missing

## Context
The launch picker marked Oh My Pi "Not installed" yet kept Launch enabled. The task moved to "Agent is Working" over a pane that died at once: `launchTaskPty` swapped the command for the `agent-check` retry wrapper (`zsh agent-check.sh`), and only then `applyAgentHooksToCommand` spliced omp's `--hook <path>` after the command's first token, which was now `zsh` (`zsh: no such option: hook`).

## Decision
- `src/bun/agent-launch-availability.ts` (`assertLaunchAgentsInstalled`) is the one launch-boundary check. It runs in the bun process, so it judges the execution host (remote/browser mode included), and it resolves the agent/config exactly as the launch does (null agent = default, `baseCommandOverride`, per-agent custom path). Called before anything moves in `spawnVariants`, `addAttempts`, `launchTaskWithAgentChoice`, `spawnAgentInTask`, `spawnBugHuntersInTask`, and in the executor's `prepareTask` before `createWorktree` (covers the CLI/board move path). A refused scheduled launch keeps its reason in `preparationError`.
- A probe that throws is "unknown" and never blocks — failure to look is not proof of absence.
- Hooks are spliced before the retry wrapper is built, so the wrapper's `original-cmd` carries them and the wrapper itself never does.
- `LaunchVariantsModal` blocks Launch/Schedule (aria-disabled) and shows `AgentInstallNotice`: install command (per platform, `src/shared/agent-install.ts`), Copy, Check again.

## Risks
The retry wrapper stays for reopen/resume (an existing worktree may hold work) and for a binary removed mid-preparation. Install commands other than omp's Windows one are still single-platform.

## Alternatives considered
UI-only gating (stale picker, CLI and scheduled launches still spawn a dead pane); deleting the retry wrapper (reopens would lose their wait-for-install pane); failing inside `launchTaskPty` (a worktree and setup run first, then get torn down).
