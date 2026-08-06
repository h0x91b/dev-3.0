# 137 — Isolate test processes by worktree

## Context

Parallel agents run identical Vitest files from different worktrees. Several tests used fixed `/tmp/dev3-*` directories and one real Unix socket, so one run could delete, overwrite, or connect to another run's resource even though their source trees were separate.

## Investigation

A single `socket-client.test.ts` run passed 14/14, while two concurrent runs both failed by receiving each other's responses or losing the shared socket. The broader audit found the same pattern in data persistence, worktree creation, shared image/artifact, port-pool, log, HOME, XDG, and standalone pane E2E paths; real ports were mocked and the tmux E2Es already used globally unique PID-specific socket names.

## Decision

Every Vitest config now calls `configureTestIsolation` from `test-isolation.ts`, which redirects HOME, tmp, XDG, logs, and DEV3_HOME beneath a root keyed by worktree hash, suite, and PID. Stateful tests and runtime scratch files must derive explicit fixtures from `DEV3_TEST_ROOT`, and the standalone pane E2E configures the same sandbox through its preload; tmux sockets keep their shorter PID-specific names to stay below Unix socket path limits.

## Risks

Tests no longer inherit the developer's HOME or global Git/XDG configuration, which may expose tests that accidentally depended on local machine state. Sandboxes use more temporary directories during a run, but global teardown removes each run root after Vitest finishes.

## Alternatives considered

Adding a random suffix only to known hardcoded paths would fix today's collisions but leave every future implicit HOME, log, or tmux path unsafe. Serializing test runs across worktrees would remove the product's intended parallelism, while a worktree-only root without suite/PID isolation would still collide when the same suite is launched twice in one worktree.
