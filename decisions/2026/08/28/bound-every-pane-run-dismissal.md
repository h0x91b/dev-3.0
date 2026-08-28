# Every pane run closes itself eventually, failures included

## Context

`decisions/2026/08/27/auto-close-successful-pane-runs.md` gave a successful run a 10-second timer and
left everything else waiting for Enter forever. That split turned out to be the wrong half of the
problem: a session's panes are mostly *red* ones — a failed `test:full`, a build that did not compile
— so the user still ended up with a row of panes to close by hand, and reported exactly that again
with a screenshot of two `exit code 1` panes sitting on `press Enter to close this pane`.

## Decision

`paneRunDismissal(exitCode)` in `src/shared/pane-runs.ts` now returns a timer for every outcome:
`PANE_RUN_AUTO_CLOSE_SECONDS` (10s) on exit code 0, `PANE_RUN_FAILED_AUTO_CLOSE_SECONDS` (30 minutes)
on anything else, including the `null` a signal death writes. A key press still closes a pane sooner.
`autoCloseMs` lost its `null` case with the branch that read it (`waitForDismissal` in
`src/cli/commands/pane-exec.ts`) — no outcome asks to wait forever, so no code models it.

30 minutes is chosen so the output of a failure is still on screen when the user comes back from
lunch, while yesterday's red builds are not. The pane is a courtesy either way: the full output lives
in the run's log and `dev3 pane logs <run-id>` reads it after the pane is gone.

The skill text (`SKILL_PANES` in `src/shared/agent-skill-content.ts`) now states closing panes as the
agent's own duty — `dev3 pane close <run-id>` per run and a `dev3 pane list` check before ending a
turn — and demotes the timer to a backstop for panes the agent abandoned.

## Risks

A failure nobody looked at within 30 minutes disappears from the screen; the log is the fallback, and
the timer is the only thing standing between a long session and a wall of dead panes. Both numbers
stay constants with no setting behind them, deliberately, until someone asks for a different value.
The 30-minute path cannot be waited out in a test — it is proven by the unit assertion on the
constant plus an e2e run with the constant temporarily shrunk to 3 seconds.

## Alternatives considered

Keeping failures on screen forever (what the user just rejected); one timer for both (a green run
does not deserve 30 minutes of screen, and a red one does not survive 10 seconds of attention); a
per-project setting (a settings surface for a number nobody has disputed twice yet).
