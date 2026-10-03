# A report's file path is storage, not a presentation format

## Context

A peer-launched agent (Seq 2070) was briefed with "Report …/REPORT.md" and published that file with `dev3 show-artifact REPORT.md`, so the user got the plain Markdown viewer instead of the dev3 HTML template. The protocol said to publish `.md`/`.txt` directly "only when that format is requested", and the agent read a `.md` path in its brief as that request. The user ruled that HTML is the default and Markdown is the exception, only on explicit request.

## Decision

Wording only, in `SKILL_ARTIFACTS` (`src/shared/agent-skill-content.ts`): every report a human reads defaults to the template; `.md`/`.txt` publish directly only when the user explicitly asks for Markdown or plain text; a `.md` path in a brief names where the file is saved, not how it is shown. The `show-artifact` line in the attention section stops listing `.md | .txt` as equal options, and `dev3 show-artifact --help` says the same. The edit is net shorter (−80 characters per body), because the protocol is at its Windows command-line cap. `buildHandoffMessage` (`src/bun/agent-launch-handoff.ts`) is unchanged: it has ~150 bytes left before it spills to a file, and the protocol rule already covers the case.

## Risks

Guidance, not enforcement: `dev3 show-artifact notes.md` still publishes silently, so an agent that ignores the rule is not stopped.

## Alternatives considered

- **Refuse `.md` without a `--plain` flag** — would enforce the rule, but it breaks every existing script and agent that publishes Markdown on purpose. Held back until the user rules on it.
- **Wrap `.md` in the template shell automatically** — overlaps with the separate task on how Markdown artifacts look, and changes what explicit Markdown publishing produces. Left to that task.
- **Restate the rule in the handoff message** — duplicates the protocol and spends most of that message's remaining byte budget.
