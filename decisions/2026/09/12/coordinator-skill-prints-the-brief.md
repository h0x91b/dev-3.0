# /dev3-coordinator prints the role brief instead of delivering it

## Context

A task often turns into a coordination job halfway through its own conversation. Until now the only
ways in were creating a new task with `--type coordinator` (losing the conversation) or running
`dev3 task update --type coordinator` from somewhere else. Run from inside the task's own session,
that command types the full role brief back into the pane of the agent that ran it: a second copy,
a second turn, and a role change that looks like it fired twice.

## Investigation

`task.update` already owns the honest half of the flow — it strips every type's preamble, writes the
new one into the description, and calls `deliverAgentPrompt` so a live agent is told. The only thing
that does not fit a self-promotion is the delivery: the caller is the agent being promoted, and it is
already reading the command's output.

`presetPromptForTaskType` (`src/shared/types.ts`) resolves the effective brief — project override,
then the Settings one, then the built-in `COORDINATOR_PROMPT`. A skill file with its own copy of that
text would rot at the first edit and would ignore both overrides.

## Decision

`dev3 task update --type <t> --print-role` (`src/cli/commands/task.ts`, handler in
`src/bun/cli-socket-server.ts`) returns the effective preamble as `rolePrompt` and the CLI writes it
to stdout, while the pane delivery is skipped and reported as `roleDelivery: "printed"`. The brief is
returned for the resulting type whether or not the type changed, so a repeat is idempotent and still
prints. The flag is refused against any task but the caller's auto-detected one, because "skip the
delivery" is only correct when the caller is the agent in question.

The bundled `dev3-coordinator` skill (`src/bun/agent-skills.ts`) therefore contains no copy of the
brief — it runs that one command and treats its output as the new standing instruction. The body has
no `` !`command` `` injection, so installing or listing the skill cannot promote anything; only an
explicit invocation does.

## The create-and-launch default, and what it cost

A follow-up from the user put one behaviour change into the same task: a coordinator asked for a task
creates it AND asks for its launch through the normal approval flow, with no separate "shall I start
it?" question, and treats a declined launch (exit `10`) as the user parking it — no retry, no asking
why, and a timeout is explicitly not a decline. It went into `COORDINATOR_PROMPT` itself, so one edit
reaches both a coordinator that started as one and a mid-conversation promotion.

It cost 854 characters, and two ratchets guard that length: `preset-prompt.test.ts` caps the raw
string, and `agent-command-line-budget.test.ts` caps how much Windows command line a coordinator task
has left for the user's own description. Both numbers are unchanged. The clauses were folded into the
rules they belong to — creating and launching into the task-creation bullet, "a launch approval is not
one of them" into PERMISSIONS, which already owned that subject — and paid for by cutting
illustrations and justifications, never obligations: the peek bullet's "dead since minute one", the
lost-cursor bullet's "a short window silently skips the gap", the board block's description of its own
contents (the agent is looking at the block), and similar. Net: 6 184 characters, 26 under the cap.

## The stale-CLI gap

A skill file and the `dev3` binary update on different clocks: the in-app updater swaps the `.app`
bundle, and a machine can carry a skill that names a flag its installed CLI does not have. `--print-role`
is rejected before anything is written (`error: Unknown option: --print-role`), so the failure is safe
but looks like a broken skill. The body therefore names that exact string and the fallback:
`dev3 task update --type coordinator`, which every version has and which promotes identically — the
brief is delivered into the pane instead of printed, one turn later.

## Risks

- A harness lists skills at session start, so a session already running when the file is first
  written will not offer `/dev3-coordinator` until it restarts. Documented in
  `agent-support-matrix.md`; the command itself works regardless.
- The brief now reaches an agent as tool output rather than as a user turn. That is weaker framing,
  which the skill body compensates for by stating explicitly that the printed text replaces any
  earlier instruction about what the task is.

## Alternatives considered

- **Let the self-update deliver as usual.** Costs an extra turn, delivers a duplicate of text the
  agent just read, and can be `held` for ~15s — a promotion that looks unfinished.
- **Put the brief in the skill file.** Two sources of truth for a prompt that was written clause by
  clause after real coordinator mistakes, and it would ignore the project/Settings overrides.
- **A new `dev3 coordinator` command.** More public CLI surface for what is one flag on the existing,
  already-correct type-update path.
