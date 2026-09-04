# File-based reporting is the default handoff note, plus one optional `--handoff-file`

## Context

`deliverLaunchHandoff` (`src/bun/agent-launch-handoff.ts`) gave a peer-launched task one sentence: a
peer started you, report back with the reply command below. Every coordinator then sent the same
second message by hand after every single launch — brief ownership, "write a file under
`reports/`, send me only the path". Five launches meant five identical hand-typed messages.

The instruction is not a private convention. A report is long, and a long body typed into a pane can
lose its head (issue #1608, `AGENT_MESSAGE_SPILL_THRESHOLD_BYTES`); a path is a handful of bytes and
always arrives whole. So it belongs in the default note, not in a coordinator's habit.

## Decision

`buildHandoffMessage(reportsDir, launcherNote?)` composes the note. The default names the child's own
`<taskDir>/reports/` (via `handoffReportsDir`, so the path is absolute and correct per task), states
that the description is the brief, and asks for the path back. `launcherNote` is appended **under** the
default, never in place of it.

The optional half is `--handoff-file <path>` on `dev3 task move --status in-progress` and
`dev3 task create --scratch --run`. The CLI (`readHandoffFile` in `src/cli/commands/task.ts`) reads
the file and sends its text as `handoffNote`; `launcherHandoffNote` in `src/bun/cli-socket-server.ts`
picks it up and passes it to `deliverLaunchHandoff`.

A guard test asserts the wrapped envelope stays under the spill threshold with a long path and a long
sender title (measured: 850 of 1000 bytes) — over it, the first thing a booting agent would hear is a
pointer to a file containing its own handoff.

## Risks

- The note grew from ~180 to ~520 bytes. Wrapped it is 850, so the headroom before it spills is about
  150 bytes; the guard test fails rather than letting it slip.
- `--handoff-file` on a `task move` that turns out NOT to be a launch is read and ignored. Erroring
  instead would be wrong: `movesForeignTaskIntoActiveColumn` is a client-side heuristic and the server
  decides.
- The same protocol text also lives in `src/shared/agent-skill-content.ts`, which is capped by
  `agent-command-line-budget.test.ts`. Adding this wording required trimming it twice; the next
  addition there will need the same.

## Alternatives considered

- **`--handoff "<text>"` inline.** Rejected: a standing protocol is multi-paragraph, and putting it on
  a command line reintroduces exactly the length problem this note exists to route around.
- **A per-project `handoffNote` in `.dev3/config.json`.** Rejected: it is committed repo policy, while
  a coordinator's reporting protocol is per-task and changes between sessions. Wrong lifetime, wrong
  scope.
- **Appending only the file's *path* instead of its text.** Cheaper (no spill risk at all), but the
  child is stuck if the file is gone by the time it reads. Sending the text is robust and spilling is
  already handled for the whole message path.
