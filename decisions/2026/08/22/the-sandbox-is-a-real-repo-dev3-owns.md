# The sandbox is a real repo dev3 owns, seeded past the data-dir guard

## Context

A first-run user has to hand dev3 a git repository before anything in the app does
something. Two kinds of newcomer stall there: the one who has no repo on this
machine yet, and — per the personas written for this work — the corporate engineer
whose only repo is the work monorepo they are not willing to experiment on. Both
close the app having seen a dashboard and nothing else.

## Investigation

`addProjectImpl` (`src/bun/rpc-handlers/app-handlers.ts`) rejects any path at or
under `DEV3_HOME`, because a real repo living there could collide with the
synthetic `ops/<slug>` paths virtual projects use. That guard is right for a folder
the *user* picks and wrong for a folder dev3 picks for itself: `~/.dev3.0/sandbox`
is a sibling of `~/.dev3.0/ops`, so a collision is not possible.

Verified in a browser on a virgin `DEV3_HOME`, because the risk that mattered was
not registration but whether the worktree machinery tolerates a project inside the
data dir: the button created the repo, the board opened, a task cut
`dev3/task-a713246a` into
`~/.dev3.0/worktrees/<slug>/a713246a/worktree`, and the agent ran there.

## Decision

`src/bun/sandbox-project.ts` owns the path (`${SANDBOX_DIR}/dev3-sandbox`) and calls
`data.addProject` directly, so the guard in `addProjectImpl` keeps its exact old
strictness and gains no exception. `SANDBOX_DIR` is additive in `src/bun/paths.ts`
— nothing renames or moves, so the on-disk invariants hold.

Both halves are idempotent: an existing repo is never re-seeded (the user's own
work in the sandbox survives a second click) and `data.addProject` returns the
record it already has for that path. The seed is deliberately two files and no
build — an agent must be able to finish a task here with no toolchain, no network
and no npm registry. `prices.js` carries one real rounding bug, labelled as
intentional in the README, so the first prompt has something to find.

HEAD is retargeted with `git symbolic-ref` rather than `git init -b main`: the flag
is younger than the git some users run, and `init.defaultBranch` may say anything —
the branch name has to be ours, because the project record pins
`defaultBaseBranch: "main"`.

The entry point is a button **inside the first-run strip** on the dashboard
(`ActivityOverview`), not beside `Add project`: the dashboard's action row must not
grow a third permanent control for an affordance that disappears the moment a
repository exists.

## Risks

- The sandbox is a project like any other, so a user who keeps it accumulates a
  board they did not mean to keep. Removing it is one click and nothing on disk is
  deleted — the same contract as every other project.
- Its commit is authored under the user's git identity when they have one, and
  falls back to `dev-3.0 <dev3@localhost>` when they do not. A fresh laptop with no
  `user.name` therefore gets a commit not in their name, in a repo that is
  explicitly throwaway.
- `projectSlug()` of a path inside `DEV3_HOME` is long but legal, and the guard
  that used to make this path unreachable no longer covers dev3's own call. A
  future caller that accepts a user path must not copy this module's shortcut.

## Alternatives considered

- **Relax the `addProjectImpl` guard** to allow `sandbox/`. Rejected: it weakens a
  check protecting user-supplied paths in order to serve one internal caller.
- **Put the sandbox in `~/dev3-sandbox`.** Visible and easy to open in an editor,
  but it litters the home directory with a folder the user never asked for, and
  removing dev3 would leave it behind.
- **A virtual (Operations) project instead.** Rejected outright: `assertGitTask`
  refuses every git operation there, so it teaches none of the branch/worktree/diff
  loop, which is the entire thing a newcomer needs to see.
- **Clone a public sample repo.** Needs network on first run and, on this machine
  class, a registry that is often blocked. A local `git init` always works.
