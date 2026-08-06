# 115 — Deliver the dev3 protocol to Codex via `-c developer_instructions=...`

## Context

Codex CLI has no `--append-system-prompt` (an upstream PR adding one was closed unmerged). Until now the dev3 protocol reached Codex only by appending `CODEX_SKILL_BODY` to the turn-1 user prompt (`buildAgentCommand` in `src/bun/agents.ts`), which (a) polluted the first user message, (b) delivered nothing on scratch tasks (empty prompt → no append, protocol adherence relied solely on the skill file + hooks), and (c) delivered nothing on `codex resume`.

## Investigation

Codex 0.143.0 supports a top-level `developer_instructions` config key (verified in the binary and in codex-rs sources: "Developer instructions that **supplement** the base instructions"). It is injected as a `role=developer` message — above user/AGENTS.md, below system. `-c key=value` parses the value as TOML; a JSON-stringified string is a valid TOML basic string, so multi-line bodies with quotes/backticks survive (verified end-to-end with `codex exec` marker tests). `codex resume` accepts `-c` as well. `model_instructions_file` was rejected: it REPLACES Codex's built-in base instructions rather than supplementing them.

## Decision

In `buildAgentCommand` (src/bun/agents.ts), for Codex launches (unless `skipSystemPrompt`): push `-c developer_instructions=<JSON.stringify(CODEX_SKILL_BODY)>` on both fresh and resume commands, and stop appending the body to the user prompt (Cursor/OpenCode keep the prompt-append fallback). This closes the scratch-task and resume gaps and keeps the turn-1 message clean.

## Risks

- `developer_instructions` set via `-c` overrides a user's own `developer_instructions` from `~/.codex/config.toml` for dev3-launched sessions (config override precedence).
- The key is version-gated: older codex builds ignore unknown config keys silently (we don't pass `--strict-config`), so on very old codex the protocol falls back to skill file + hooks — same as the previous scratch-task behavior, no crash.

## Alternatives considered

- Keep prompt-append (status quo): leaves scratch/resume uncovered, pollutes turn 1.
- `model_instructions_file`: replaces the entire base prompt — maintenance trap, rejected.
- AGENTS.md injection: lands as user-level instructions, weaker priority than developer role.
