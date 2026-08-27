# Auto-close a pane run only when it succeeded

## Context

`dev3 pane run` held its pane open forever after the command ended (`waitForDismissal` in
`src/cli/commands/pane-exec.ts`), printing "press Enter to close this pane". Agents open a pane per
build or test run and never come back to it, so a working session leaves a row of dead panes the user
has to close by hand. Reported by a user: "Dev3 spins terminals ... and leave them open with option
to press enter to close."

## Decision

`paneRunDismissal(exitCode)` in `src/shared/pane-runs.ts` decides what a finished pane does:
exit code 0 closes the pane after `PANE_RUN_AUTO_CLOSE_SECONDS` (10s, a key press closes it sooner);
anything else — non-zero, or the `null` a signal death writes — waits for Enter as before. The wait
itself lives in `waitForDismissal`, racing a keypress against `Bun.sleep`. The skill text
(`SKILL_PANES` in `src/shared/agent-skill-content.ts`) now also tells the agent to `dev3 pane close`
a run it is done with, since nothing else ever closes a watcher's pane.

Closing a green pane loses nothing: a pane run mirrors every byte into its log file, so the output is
still readable through `dev3 pane logs <run-id>`.

## Risks

A user who looks away for 15 seconds will not find the successful run on screen; the log is the
fallback. The 10 seconds are a fixed number with no setting behind it — deliberately, to keep this
out of the settings surface until someone actually asks for a different value.

## Alternatives considered

Closing every finished pane immediately (a red build would vanish before it could be read); a
`--close-on-exit` flag plus a project setting (a whole settings surface for a default nobody has
disputed yet); leaving the code alone and only instructing the agent to clean up (relies on the agent
remembering, and the litter is created by the ordinary green path).

The UI's "Run script" pane (`src/bun/script-runner.ts`) keeps its `read` wait: that path mirrors
nothing to a log, so closing its pane would destroy the only copy of the output.
