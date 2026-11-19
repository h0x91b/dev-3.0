# `dev3 projects set`: machine-local project switches from the CLI, user or coordinator only

## Context

Some Project Settings switches live only in the project's `projects.json` record: `gitWorkflow`, `storageRoot`, `useRepoConfig`, `boardCopy`, `boardCopyMessages` and the display `name`. `dev3 config` writes `.dev3` files only, so `dev3 config schema gitWorkflow` answers "Unknown config key" and an agent asked to switch a board's git workflow had to send the user to the UI. The fields stay out of `Dev3RepoConfig` on purpose: a repository must not be able to set them for itself (`decisions/2026/09/11/ignore-repository-dev3-config.md`).

## Decision

- New subcommands `dev3 projects get [<key>]` and `dev3 projects set <key> <value>`, backed by `projects.settings.get|set`. The set handler calls `updateProjectSettings`, the same function the Project Settings screen calls, so the live-task blockers, the not-a-repo refusal and the storage copy behave exactly as in the app.
- The key list is `PROJECT_CLI_SETTINGS` in `src/shared/project-cli-settings.ts`. It is a separate command, not new `dev3 config` keys: `config` means `.dev3` files, and mixing in registry fields would blur what a repository can set.
- Writes are allowed from the user (no task context) and coordinator tasks; any other task is refused with exit 49 (`CLI_EXIT_CODE_PROJECT_SETTING_FORBIDDEN`). This is the `dev3 epic create` rule: these switches change how every task of the project runs, so a task agent asks the user. A coordinator may also change another project's switches with `--project`: it already speaks for the user, and confining it to its own project would add a check without stopping anything the user could not do in the UI.
- A value the UI would not offer in the project's current state is refused with exit 50 (`CLI_EXIT_CODE_PROJECT_SETTING_UNAVAILABLE`): `boardCopyMessages on` while `boardCopy` is off, because the UI shows that toggle only while the board copy is on, so the user could neither see nor clear it; and `boardCopy on` on an operations board, which `updateProjectSettings` would drop without a word.
- An open Project Config tab reseeds its form when a pushed project's `useRepoConfig` differs from the value the form was seeded with, and warns when that drops unsaved edits. Without it, a CLI flip followed by Save would write values resolved the other way, for example repo-file scripts into `projects.json`.
- Left out: `sensitive` and `autoAccountExclusions`, whose whole value is that only the user sets them; `githubAuthHost/Login`, which needs account validation; prompt and artifact overrides, which nobody asked for yet.

## Risks

- The caller is identified the way `epic create` does it: `detectContext` takes the task from the working directory's worktree path, then falls back to the injected `DEV3_TASK_ID` (`src/cli/context.ts`). An agent that leaves its worktree is still known by that variable. The gaps are an agent shell with `DEV3_TASK_ID` unset, which passes as the user, and a `cd` into a coordinator's worktree, which passes as that coordinator because the path wins over the variable. An agent can also make its own task a coordinator with `dev3 task update --type coordinator`, which the agent protocol forbids. Either way this is a guardrail against an agent flipping a switch by mistake, not a security boundary: the same agent can already edit `projects.json`.
- `! dev3 projects set ...` typed into an agent's prompt runs in the task's folder, so it is refused as well. The user runs it from a terminal outside any task or uses Project Settings.

## Alternatives considered

- An in-app approval dialog for each change. Rejected for now: the approval system is built per task and per kind (complete, cancel, reset, launch), and a new kind needs its own dialog and strings. The user-or-coordinator rule needs none.
- Adding the keys to `dev3 config`. Rejected: see above.
