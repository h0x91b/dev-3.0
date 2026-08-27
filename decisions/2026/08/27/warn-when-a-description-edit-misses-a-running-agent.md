# Warn when a description edit misses a running agent

## Context

A coordinator widened a running child task's scope by rewriting its `description` with
`dev3 task update --description`, then treated the brief as delivered. The child never found out and
sat idle for twenty-five minutes until it was sent a `dev3 message`. Nothing in the CLI, the help
text, or the dev3 skill said the edit does not reach a live agent — while `--type`'s own help text
advertises that it *does* tell a running agent, which invites the reader to generalise.

## Investigation

The description is templated into the agent's launch command
(`resolveCommandForProject` → `buildTaskPrompt`, `src/bun/rpc-handlers/tmux-pty.ts:705`), and the
Claude adapter attaches the prompt only `if (!resume)` (`src/shared/agent-adapters/claude.ts`). The
`task.update` socket handler pushes `taskUpdated` to the renderer and calls `deliverAgentPrompt`
**only** for a `--type` change (`src/bun/cli-socket-server.ts:970`). So nothing pushes a description
edit to the agent: a fresh launch reads the new text, a resume does not, and the agent otherwise sees
it only if it re-runs `dev3 current` / `dev3 task show`, both of which print live task state.

## Decision

Say it at the keyboard as well as in the docs, without changing delivery behaviour.

- `taskAgentSessionLooksLive()` in `src/shared/types.ts` — a pure predicate over the same field
  subset `isTaskDisconnected()` reads. Derived from persisted state, never probed, so it may only
  decide whether to *tell* the user something.
- `updateTask()` in `src/cli/commands/task.ts` prints a note after a successful `--description`
  update when that predicate holds, naming the `dev3 message --task <id>` command to send too
  (carrying `--project` when the caller passed one).
- Wording added to `dev3 task update --help` (`src/cli/help.ts`) and to the dev3 skill
  (`src/shared/agent-skill-content.ts`), so every agent learns it at startup.

`--title` is left silent on purpose: it is equally undelivered, but an agent renames its own task on
every session start, so a hint there would fire constantly on a correct action. A title is a card
label, not the brief.

## Risks

The predicate can be wrong in the harmless direction only — a stale `runtimeState` makes it print a
note for an agent that is already gone (advice that costs one `dev3 message` attempt), or stay quiet
about a task whose runtime hint was written `idle` while its agent lives. Neither affects delivery.
The note is one extra line on a common command; it fires only on `--description`, only on live tasks.

## Alternatives considered

- **Make `--description` actually notify the agent like `--type` does.** A behaviour change, and it
  would type into an agent mid-turn on every edit — deliberately out of scope, a separate decision.
- **Docs only.** Cheapest, but the trap is at the keyboard; the coordinator that hit it had read the
  skill.
- **Probe the terminal backend for a live agent pane before printing.** Accurate, but it makes a
  cheap metadata write depend on tmux/native reachability, and being wrong here costs nothing.
