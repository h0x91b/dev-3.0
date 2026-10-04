# An explicit non-HTML request overrides the template default

## Context

`ARTIFACT_FORMAT_RULES` (`src/shared/agent-skill-content.ts`, shared by the protocol and the `dev3-artifact` skill) said: if "do not generate HTML" conflicts with the template, ask which wins. A Codex agent told "no HTML" did exactly that — it held a finished report and asked the user to choose between the template and `.md`, although the user had already answered.

## Decision

The template is the default only. An explicit ask for Markdown, plain text or no HTML overrides it: the agent writes that format, publishes the `.md`/`.txt` directly, and does not ask again. The ruling from `decisions/2026/10/03/report-path-is-storage-not-presentation.md` stays: a `.md` report path in a brief names storage, not a format request. The `dev3-artifact` skill description says the skill is skipped on such a request. The edit is net shorter.

## Risks

"Explicit" still needs judgement: an ambiguous phrase such as "keep it simple" is not a request for Markdown and keeps the default.

## Alternatives considered

- **Keep asking, but word the question better** — still re-asks a question the user already answered.
- **Treat any non-HTML mention as an override** — reopens the loophole where a `.md` storage path read as a format request.
