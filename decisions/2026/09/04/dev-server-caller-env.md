# A dev server takes caller-supplied env from a flag, not from a config file

## Context

The devScript's environment came from three places, all of them owned by dev3: the project `env`
(`.dev3/config.json` + `.dev3/config.local.json`), the lifecycle `DEV3_*` vars, and the allocated
pool ports. An agent that needed one more variable had exactly one route — write it into
`.dev3/config.local.json` — and that file is worktree-wide: it also reaches the agent sessions of
that worktree, and a forgotten entry silently boots the next run on the wrong configuration. The
concrete case is `/debug-ui`'s scoped QA board (`DEV3_QA_SCOPE`, see
`decisions/2026/08/21/scoped-qa-app-instance.md`), where a leftover file puts a later QA run on a
throwaway board without saying so.

## Decision

`dev3 dev-server start --env KEY=VALUE` (repeatable), and the same on `restart`. Deliberately
generic: `dev3 dev-server` is every project's command, so it learns nothing about dev-3.0 or
`scripts/qa-scope.ts` — the dev-3.0-specific recipe lives in the repo-local `/debug-ui` skill.

- **Precedence is the group order** in `runDevServer` (`src/bun/rpc-handlers/tmux-pty.ts`):
  project config < caller `--env` < lifecycle `DEV3_*` < assigned ports. Later wins, because
  `buildDevServerScript` emits one export paragraph per group. So a caller can override a project
  `env` entry and nothing else. Asserted at the call site in
  `src/bun/__tests__/tmux-pty-devserver-env.test.ts`, and executed for real (all three platforms)
  in `src/bun/__tests__/dev-server-pane.bun-e2e.ts`.
- **Names dev3 owns are refused, not outranked.** `PATH`, `HOME`, `SHELL`, `DEV3_TASK_ID`,
  `DEV3_WORKTREE_ROOT` and every `DEV3_PORT*` (`src/shared/dev-server-env.ts`). Ordering alone
  would not be enough: `PATH` appears in no later group, and a caller that moved `DEV3_PORT0`
  would break `--wait`, which polls for a listener on exactly that port. The CLI rejects with
  `CLI_EXIT_CODE_DEV_SERVER_ENV_INVALID` (21) and starts nothing; the handler filters again,
  because `devServer.start` is also reachable from the renderer and any socket client.
- **Where it is remembered:** `src/bun/dev-server-env-store.ts`, one JSON file in the task's temp
  dir next to the generated wrapper. A bare `restart` (and the UI's Restart button) reuses the
  last start's env; `restart --env` replaces it; `stop` clears it; a plain `start` clears it too,
  so a start always defines its configuration whole. On disk rather than in memory because a tmux
  dev session outlives the app process, and `status` must still be able to name the keys.
- **Values never leave the machine and never reach a log or a screen.** `DevServerStatus` carries
  `extraEnvKeys` — names only, sorted — and the `→ runDevServer` log line redacts `params.env` to
  its keys. A value passed this way can be a token.

## Risks

An agent can now change what the devScript sees without leaving a trace in the repo, which is the
point but also means a scoped QA board is invisible to anyone reading the worktree. Mitigated by
`dev3 dev-server status` printing the key names, and by `stop` clearing them.

`ParsedArgs.repeated` is optional (`src/cli/args.ts`): a hand-built fixture has no repeats, so a
command that reads a repeatable flag must go through `parseArgs` or it sees nothing. Making it
required would have churned 24 test files for no behavioural gain.

## Alternatives considered

- **A `--qa` flag on `dev3 dev-server`.** Rejected outright: the command is universal, and baking
  one repo's fixture modes into it is the wrong layer.
- **Keep the config file, add a `dev3 config set env.KEY` command.** Same leak, plus a second way
  to write a file that already has two layers.
- **Store the env on the `Task` record.** It is per-run scratch, not board state, and
  `~/.dev3.0` is shared with every other installed version of the app (AGENTS.md on-disk
  invariants) — a new field there buys a compatibility promise for nothing.
- **Let the caller's env win over the ports too.** Rejected: `--wait` and the port-conflict
  reporting both key off the assigned ports, so a caller able to move them turns a working start
  into a silent timeout.
