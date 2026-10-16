# Coordinator prompt cap raised from 6 210 to 6 500

## Context
`COORDINATOR_PROMPT` is prepended to a coordinator task's description, which still travels as argv for every adapter, so on Windows it shares the 32 767-character line. Its 6 210 cap was the prompt's length before the events block, frozen as a no-regression ratchet on description room. It was not an OS limit. Adding the launch-preference rule left almost no room under it.

## Investigation
The Seq 2160 audit showed the cap protects description room, not launchability. Raising it to 6 500 leaves gemini 26 237 and the custom adapter 26 226 characters of description, measured with the real `resolveAgentCommand` on simulated win32. The test floors are 26 200 / 26 190: at the exact maximum, one extra escaped quote in a prompt still under the cap failed the test (verified). Before the raise the two cap tests disagreed: the raw cap was 6 210, but the gemini floor effectively allowed only about 6 200.

## Decision
Arseny approved 6 500. `COORDINATOR_PROMPT_LIMIT` in `src/shared/agent-command-line-budget.ts` is the single number. `preset-prompt.test.ts` checks the raw length against it. `agent-command-line-budget.test.ts` measures the launch line with the prompt padded to that limit, so the cap and the launch-room floors cannot drift apart again.

## Risks
Every point of the cap a prompt actually uses comes out of the user's description room on Windows. The ~37-character floor slack absorbs a few escaped quotes or backticks; a prompt much denser in them fails the launch-room test before reaching the cap. The codex/cursor/opencode coordinator launch overflow found by the audit is a separate, unfixed issue.

## Alternatives considered
Keeping 6 210 and trimming prose (done once for this rule, 2026-10-16). Dropping the cap entirely: no signal left before description room silently shrinks.
