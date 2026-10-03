# The dev3-artifact skill shares the protocol's artifact text instead of copying it

## Context

Users asked for a dedicated `/dev3-artifact` skill in addition to the dev3 protocol, which already carries a `## dev3 HTML artifacts` section. Two copies of the same rules drift: the HTML-template default and the "a `.md` report path is storage, not presentation" ruling (`report-path-is-storage-not-presentation`) changed only days ago.

## Decision

`src/shared/agent-skill-content.ts` exports the section's two halves as `ARTIFACT_FORMAT_RULES` and `ARTIFACT_AUTHORING_STEPS`. The protocol's `SKILL_ARTIFACTS` is built from them plus one pointer line; `ARTIFACT_SKILL_CONTENT` in `src/bun/agent-skills.ts` embeds both verbatim and adds only what the protocol leaves implicit (re-running `dev3 artifact-template` overwrites an edited copy, revising by version, the `/dev3-share-artifact` boundary). `AUTHORING.md` stays the only authoring card; the skill points at it rather than repeating it. A test asserts both fragments appear in every protocol variant and in the skill.

## Risks

The protocol keeps its full section, so the body grew by 45 characters; codex on Windows is now about 50 characters under `AGENT_SKILL_BODY_LIMIT`. The next addition to the protocol must cut prose elsewhere.

## Alternatives considered

Moving the workflow out of the protocol into the skill alone would save budget but leave agents that never load the skill without the HTML default. Embedding `AUTHORING.md` into the skill would duplicate the card every report already reads from its copy.
