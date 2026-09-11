# `dev3 pr create` runs git and gh locally, and gates on gh before pushing

## Context

Opening a pull request from a task used to be a handoff: the UI types a prompt into the
agent's pane and the agent runs `git push` and `gh pr create` itself
(`createPullRequest` in `src/bun/rpc-handlers/git-operations.ts`). Agents therefore
re-derived the same recipe every time — including the origin-task footer, which is easy
to forget or to paste with the wrong task id.

## Decision

`dev3 pr create` (`src/cli/commands/pr.ts`) does it in one command, entirely in the CLI
process: `gh --version` → `gh auth status` → `git rev-parse` → `git push -u` →
`gh pr create` → optional `gh pr merge --auto --<strategy>`. It is routed in `main.ts`
next to `doctor`/`inline-html`, before socket resolution, so it works with the app
closed.

Three choices worth stating:

- **The `gh` check runs before the push**, with its own exit code 23
  (`CLI_EXIT_CODE_GH_UNAVAILABLE`). Discovering a logged-out `gh` after the push leaves a
  branch on the remote and no pull request, which reads as a half-done command.
- **The footer comes from `shared/deep-link.ts`**, the same source the UI handoff uses, and
  is dropped under the same two conditions (no `dev3://` handler on this platform, or
  `prOriginTaskLink === false`).
- **`prOriginTaskLink` is read straight out of `~/.dev3.0/settings.json`** rather than
  through `src/bun/settings.ts`. That module pulls the backend logger and data layer into
  the CLI's static import graph, which `cli-startup-graph.test.ts` exists to keep light;
  this is one boolean, and `doctor.ts` already reads the same file directly.

## Risks

The default base branch comes from the task's stored `baseBranch`, so a task whose branch
was later retargeted by hand gets the old base unless `--base` is passed. Reading
`settings.json` inline means a future rename of that field has two call sites; both are
named in the comment.

## Alternatives considered

Route it through the app's RPC and reuse `createPullRequest`: rejected because that path
is a *handoff* (it types a prompt at an agent) and because it would make opening a pull
request require a running app. Keep it a handoff and only document the recipe better:
rejected — the footer and the base branch were exactly what got dropped.
