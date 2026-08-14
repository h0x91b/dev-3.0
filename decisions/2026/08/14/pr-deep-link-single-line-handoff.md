# The PR handoff prompt stays on one line

## Context

The Create-PR handoff types a plain-language prompt into the task's agent pane. Until
now every such prompt was a single line; the origin-task deep link (#1339) embedded a
multi-line markdown block into it, and the opt-out work (#1342) kept that shape.

Review of #1339 flagged the risk but could not settle it: text reaches the pane as raw
bytes via `send-keys -H`, and only `U+0000` is filtered (`src/shared/pane-input.ts`).
Claude Code absorbs a fast newline into its input box, but dev3 also drives Cursor
Agent, Codex, Gemini CLI and OpenCode, and an agent that reads `\n` as Enter would
submit half the prompt and receive the rest as a second, junk one.

## Investigation

The alternative fix — proving the behavior agent by agent — needs a live pane per agent
and has to be redone whenever any of them changes its input layer. Removing the newline
removes the question instead of answering it.

## Decision

`buildTaskPrDeepLinkLine` (`src/shared/deep-link.ts`) is the newline-free footer
content, and `createPrAgentPrompt` passes THAT, describing the `---` divider in words.
`buildTaskPrDeepLinkSection` still renders the full block for the agent skill and the
tests. Two tests pin it: the line contains no newline, and the assembled prompt
contains none either.

The link stays last in the prompt (after the auto-merge sentence) for the reason
recorded in [pr-deep-link-opt-out-and-block-ordering](../13/pr-deep-link-opt-out-and-block-ordering.md):
anything trailing it reads as part of the line the agent was told to copy exactly.

The dev3 agent skill (`agent-skill-content.ts`) and the `ask-dev3` flow map
(`agent-skills.ts`) now state the footer and its opt-out, so an agent writing a PR
description by hand produces the same footer the button asks for.

## Risks

- The footer's markdown now lives in the prompt as prose ("a blank line, then a `---`
  divider") rather than as a literal block, so a sloppy agent could format it slightly
  differently. Acceptable: the link itself is copied verbatim, and the divider is
  cosmetic.

## Alternatives considered

- **Verify each agent and keep the block.** Rejected: per-agent verification expires
  with every agent release.
- **Send the block as a second delivery stage.** More moving parts in a path whose
  three-answer delivery contract is already subtle.

## Credit

The single-line approach, the skill updates, the toggle tests and the settings
normalization test are @BnayaZil's, from the closed PR #1344 — this record and the
change that carries them exist because that PR was better than the merged #1342 in
exactly these places. The feature itself is his, from #1339.
