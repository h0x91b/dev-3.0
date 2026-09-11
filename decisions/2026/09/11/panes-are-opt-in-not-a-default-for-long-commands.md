# A pane is opt-in, not the default for anything long-running

## Context

The injected protocol told every agent that "Anything long-running or streaming (build, test run,
watcher, log tail) goes in a neighbouring pane instead of blocking your own tool call"
(`SKILL_PANES` in `src/shared/agent-skill-content.ts`). The only named alternative was "quick
one-shot commands", with no threshold for "quick". Agents therefore split a pane for routine work,
and the user's terminal filled with panes he never asked for.

## Investigation

An audit of every pane instruction (task Seq 1880) found the softer criterion — "long-running **and
the user benefits from watching live**" — existed only in `/dev3-tmux`, an optional skill an agent
rarely loads, while the unconditional wording sat in the mandatory system prompt. A grep of past
Claude transcripts showed the real pane runs were dominated by `bun run dev --qa`, `vitest run` and
`test:full` — exactly the commands the repo's own rules already say to start elsewhere. The tmux
skill also carried an incentive pointing the wrong way: "Long-running commands stealing your tool
slot … a tmux pane fires-and-forgets and you get your next tool call back immediately."

## Decision

The trigger is now the user, not the command. `SKILL_PANES` states that the agent's own shell is the
default and names two cases for a pane: the user asked to watch something run, or the process must
outlive the turn (watcher, log tail, long-lived process). Builds, test suites and checks stay inline
however long they take, and the section says plainly that a pane is not a way to free up a tool
call. `TMUX_SKILL_BODY` §3 in `src/bun/agent-skills.ts` was rewritten to the same three cases, and
its "stealing your tool slot" pitfall was inverted into "opening a pane to free up your own tool
call". `src/bun/__tests__/agent-skills.test.ts` pins the new heading and the default-to-your-shell
line.

The backend-truth lines from `decisions/2026/08/14/backend-agnostic-pane-runs.md` (`dev3 pane list`,
never assume tmux) are untouched — that incident was about an agent believing a false statement
about its terminal, not about how often it splits.

## Risks

Agents will now block their own tool call on slow builds and test runs, so a turn can take longer
before anything is reported. A genuinely useful live view may be missed when the user did not think
to ask for one. Both are cheaper than a terminal the user has to clear.

## Alternatives considered

Deleting the section entirely — rejected, it re-runs the Windows incident where an agent with no
statement about its backend reached for tmux that does not exist. Moving it into a user-invocable
skill — rejected as an extra hop that also hides the pane commands when they are genuinely needed.
Keeping the wording and adding a duration threshold — rejected because models estimate duration
poorly in advance and "Anything long-running" would still lead the paragraph.
