# CLI `task create --type` goes through the preset-prompt seam, not the GUI's create path

## Context

The GUI could create a coordinator or a pr-review task; the CLI could only create a
standard one and then call `dev3 task update --type`. Between the two calls the task
exists with the wrong role preamble, and a task launched in that window hands its agent
the standard brief.

## Investigation

There are two independent creation paths, and they already were before this change:

- The GUI calls the `createTask` RPC (`src/bun/rpc-handlers/task-lifecycle.ts`). Its
  `taskType` param only stores the field — the preamble is composed in the renderer
  (`CreateTaskModal.tsx`) before the call.
- The CLI calls the `task.create` socket op (`src/bun/cli-socket-server.ts`), which goes
  straight to `data.addTask`.

So there is no shared "create a typed task" function to route through, and the renderer's
composition is not reachable from the socket server.

## Decision

The seam that actually defines what a type means is `presetPromptForTaskType` +
`withPresetPrompt` in `src/shared/types.ts` — the same pair the modal and
`task update --type` both use. `task.create` now calls it too, so all three writers of a
role brief resolve the same project → settings → built-in override chain. Merging the two
creation paths was out of scope for this task and would have touched GUI task creation,
which the task forbade.

Two consequences worth naming:

- A typed create also sets `customTitle` from `--title`. Without it the card would be
  named after the first 80 characters of the preamble, so every review card would read
  alike — the same reason `createTask` has its `reviewTitle` branch.
- `--type` is refused together with `--scratch --run`. A scratch task has no prompt by
  design, so there is nothing to put a role brief above.

Unknown values exit 3 (`CLI_EXIT_CODE_USAGE_ERROR`) via the existing `exitUsage`; no new
exit code was needed. `src/cli/commands/task.ts` now reads `--type` through one
`parseTypeFlag` helper shared by `create` and `update`, so the two commands cannot drift
into accepting different spellings of the same three roles.

## Risks

`data.addTask` is called with a body that already contains the preamble, so the derived
title comes from the preamble unless a title is given. `--title` is required by the CLI,
so in practice this cannot happen through the command; a socket caller that omits the
title cannot reach the handler at all (it throws first).

## Alternatives considered

- Have the CLI compose the preamble itself and send a finished description, the way the
  modal does. Rejected: it puts the rule in a third place and lets the CLI and the app
  disagree about the project's override.
- Route `task.create` through the `createTask` RPC handler. Rejected: that handler does
  not write the preamble either (the renderer does), so it would have fixed nothing while
  changing the GUI's create path.
