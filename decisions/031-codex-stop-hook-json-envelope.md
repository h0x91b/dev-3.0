# 031 — Codex Stop Hooks Return an Explicit JSON Success Envelope

## Context

Codex `Stop` hooks in dev-3.0 worktrees were still failing with `hook returned invalid stop hook JSON output` even after `dev3 task move` stopped printing the human-readable `Moved task ...` line for `--codex-stop-hook`. We needed a Codex-only fix that keeps the task transition working without changing normal CLI output for humans or other agents.

## Investigation

We checked Codex's local source under `~/Desktop/src-shared/codex/` and found that `codex-rs/hooks/src/events/stop.rs` accepts empty `stdout` for exit code `0`, but any non-empty `stdout` must parse as JSON. In practice that still left us exposed to stdout leakage outside the core move message, so relying on "silence means success" was too brittle for worktree hooks.

## Decision

Codex Stop hooks now use two layers in [src/shared/agent-hooks.ts](src/shared/agent-hooks.ts): the generated hook command redirects the wrapped `dev3 task move ... --codex-stop-hook` stdout to `/dev/null`, then prints a minimal `{}` JSON envelope only on success. The CLI path in [src/cli/commands/task.ts](src/cli/commands/task.ts) also returns `{}` for `--codex-stop-hook`, so older generated hooks that already include the flag keep working after a dev3 upgrade.

## Risks

This still assumes no unrelated shell startup output is printed before Codex executes the hook command body, because that output would happen before our command-level redirection. We also rely on Codex continuing to accept a bare `{}` as a valid no-op Stop hook response.

## Alternatives considered

- Keep empty stdout for `--codex-stop-hook`: rejected because the real failure persisted and the contract proved too easy to violate accidentally.
- Return a richer JSON payload with `systemMessage`: rejected because Codex only surfaces it as a warning entry and it does not affect the agent's continuation context.
