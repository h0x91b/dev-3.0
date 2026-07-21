# 149. Task lifecycle state machine with declared effects

## Context

Task activation, preparation, column moves, teardown, and git watchers coordinated through several RPC handlers and process-global mutable collections. Their implicit ordering and locally invented race guards made lifecycle behavior difficult to audit and left crash recovery incomplete.

## Investigation

The existing external contract is load-bearing: RPC responses, CLI guards and exit codes, push message names, teardown ordering, merge-prompt suppression, and column-agent handoffs must remain unchanged. The most important races happen when a stale asynchronous finding writes after a newer user or hook move, so checks made before the write are insufficient.

## Decision

`src/bun/lifecycle/` owns a pure `transition(state, event)` table, a per-task actor/mailbox, declared activities, and a separate effect interpreter. Kanban column and runtime phase are independent state dimensions; actors reload task state at dequeue time, and an additive persisted runtime hint is reconciled against tmux and worktree reality at boot.

## Risks

This is a broad replacement of load-bearing behavior, so an omitted effect or ordering change can regress rare lifecycle paths. Pure scenario tests and the existing RPC/CLI suites remain the behavioral boundary, and runtime persistence never renames or migrates shared on-disk paths.

## Alternatives considered

A staged strangler and a feature-flagged parallel implementation would lower cutover risk but preserve dual ownership and the same race class during migration. A smaller status-only machine would leave preparation and poller findings outside the serialization boundary, so both were rejected for this implementation.
