# Retire the detached-PTY development spike

## Context

The single-session spike was explicitly removable; [the registry decision](../../07/22/native-session-registry.md) chose an independent successor. The approved cleanup retires its manual tracer as well as its implementation, without touching prototype metadata or running hosts.

## Investigation

Production uses `src/bun/native-terminal-registry/` through the task-terminal, backend and packaged-host seams; its isolation test forbids prototype imports. Repository references to the spike were its own CLI/tests, a package command, the home-resolver regression test and advisory inventory; the native lifecycle and Windows packaging proofs exercise the successor.

## Decision

Delete `src/bun/prototypes/detached-pty/` and `test:proto-e2e`, remove their coupled test/scope references, and retain the production packaging exclusion guard. Remove the three manifest overrides and four advisory inventory rows; recalculate entry summaries with the existing inventory renderer while retaining historical scan counts, explicitly marked as a partial update.

## Risks

Manual diagnostic users lose the retired tracer; its source remains in git history, and reverting this cleanup restores it. The full advisory generator already reports unrelated manifest/snapshot drift, so this change does not certify a fresh inventory or repair those classifications; production lifecycle, Windows/native/tmux support and shared on-disk compatibility remain unchanged.

## Alternatives considered

Keeping the spike would retain a second lifecycle/protocol/FFI implementation after its independent successor shipped; removing only tests would leave it unvalidated. Repairing the entire tmux inventory would expand the approved cleanup and conflict with ongoing handler refactoring, so only the retired entries are pruned.
