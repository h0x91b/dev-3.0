# CLI `task create` routes through the GUI's own creation function

## Context

A `pr-review` task created from the CLI was weaker than one created from the GUI and
nothing said so. The CLI had no way to name a branch or a pull request at all, so every
CLI review task got a worktree on the base branch with the diff nowhere in sight.

The quieter half is `Task.foreignCode`. It is decided once, at creation, from the ref the
task starts on, and it gates real behaviour: dev3 then ignores that branch's committed
`setupScript`/`devScript`/`cleanupScript`/`env`/`builtinColumnAgents` and skips agent trust
and `.mcp.json` pre-approval. A task created without a ref is not marked foreign, so an
agent that checks the contributor's branch out by hand does so with the trust decision
already made — on the wrong branch.

## Investigation

Confirmed, twice, before writing code.

In the code: `src/bun/cli-socket-server.ts` was a **second creation path**. It called
`data.addTask` directly, while the GUI's `createTask` (`src/bun/rpc-handlers/task-lifecycle.ts`)
is the only site that calls `git.isForeignBranchRef`. `isForeignBranchRef` returns `false`
immediately for an absent ref, so the CLI could not produce a foreign-code task at all.

On disk: `~/.dev3.0/data/Users-arsenyp-Desktop-src-shared-dev-3.0/tasks.json` — every
GUI-created `pr-review` task carries `foreignCode: true` and a fork ref
(`arditti/…`, `mcaldas/…`); the four CLI-created ones from 2026-08-27 carry neither field.

## Decision

`task.create` on the CLI socket now resolves the ref **first** and then calls the exported
GUI `createTask`, instead of writing the task itself. The new
`src/bun/task-start-ref.ts` owns both halves: `resolvePrUrl` (moved out of the RPC layer,
same implementation the GUI branch picker uses) and `resolveTaskStartRef`, which turns
`--pr <number|url>` into `origin/<head>` or `<forkOwner>/<head>` — fetching it — and
verifies a `--branch <ref>` exists under `refs/remotes` or `refs/heads`.

`--pr` implies `--type pr-review`, mirroring the GUI, where resolving a PR in the branch
picker flips the type. An unresolvable ref throws a message prefixed with
`TASK_REF_UNRESOLVED_PREFIX`, which the CLI turns into
`CLI_EXIT_CODE_TASK_REF_UNRESOLVED` (18): nothing is created, deliberately, rather than a
review task landing on `main`.

## Risks

- `isForeignBranchRef` calls **any** remote-qualified ref foreign, so `--branch origin/main`
  yields `foreignCode: true`. Pre-existing and identical in the GUI (its picker offers
  `origin/*` too); not changed here.
- `--pr` costs one `gh pr view` plus a fetch, so creation is no longer instant and can fail
  on a machine without `gh`. That is why the four causes get four distinct messages.
- Routing the CLI into `createTask` means a task created with an active status would now go
  through the lifecycle actor. The CLI never passes a status, so this path is unreachable
  today — it is a behaviour the seam now carries, not one it uses.

## Alternatives considered

- **A separate `dev3 task set-branch` after creation.** Rejected: a ref applied after the
  worktree exists is a different guarantee, and the trust decision would already be made.
- **Teach the CLI handler to compute `foreignCode` itself.** Rejected: that is the bug
  again — two implementations of "create a task" drifting apart.
- **`--branch` only, no `--pr`.** Rejected: for a review the pull request is the subject and
  the branch a detail, and only `--pr` can fetch a fork branch that is not local yet.
