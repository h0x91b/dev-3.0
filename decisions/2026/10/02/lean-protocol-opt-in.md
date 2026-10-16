# Opt-in lean protocol at launch

## Context

Every launch injects the full family protocol, about 27 KB (h0x91b/dev-3.0#1891). A large hosted model with prompt caching pays little for it. A small-context or local model routed through the model catalog loses over a fifth of a 32k window before the task starts, and Cursor/OpenCode carry it as user text.

## Decision

`DEV3_LEAN_PROTOCOL=1` on the server process makes `resolveAgentCommand` (`src/bun/agents.ts`, `leanProtocolBody`) inject the adapter's `leanSkillBody` plus `leanProtocolReference(path)`. The full body is written first to `~/.dev3.0/data/agent-prompts/<command>.md`, and the lean text names that file. Claude and omp read the lean text from `<command>-lean.md`; Codex, Cursor and OpenCode get it inline through the new `protocolBody` launch option. The lean bodies in `src/shared/agent-skill-content.ts` reuse existing sections verbatim: header, Bug Hunter isolation, session start, branch naming, title/labels/priority/type, status with the completion gate, overview, scratch tasks and the Codex shell note. `SKILL_TITLE_GENERATION` was split so review-task creation and live description edits stay out; the full bodies are byte-identical. Off by default, so default launches do not change.

## Risks

Agents follow on-demand docs less reliably than injected text, so a lean session may skip a rule it never read; the same evaluation as `measure-harness-cost-before-prompt-compaction` applies before any default change. The Claude `SKILL.md` and the compact skill wrapper still say the full protocol is in context; the lean body's reference section says otherwise, and that section wins only if the model reads it. Copilot is not covered: its protocol comes from the `sessionStart` hook in the `dev3` CLI process (`src/cli/commands/copilot-hook.ts`), which does not see the server flag. The flag is read per launch, so a resumed session may get a different body from its first launch.

## Alternatives considered

A Settings toggle with a per-project override was deferred until the experiment shows value, matching how `DEV3_COMPACT_AGENT_SKILLS` shipped. Rewriting the kept sections into a 2-3 KB summary would cut more but changes rule text without an evaluation. A new `dev3 protocol` command as the pointer target was rejected for now: a file path works for every harness with no new CLI surface.
