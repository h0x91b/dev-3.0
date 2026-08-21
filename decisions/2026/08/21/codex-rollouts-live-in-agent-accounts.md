# Codex rollouts also live under dev3's agent accounts

## Context

`dev3 conversations dump` reported five Claude sessions and zero Codex ones for a task that had a live Codex agent running in a neighbouring pane (`gpt-5.6-luna`, visible via `dev3 peek --pane 2`). The Codex parser was not at fault: pointed straight at the rollout it produced a full-fidelity parse with the task's worktree as `cwd`. The file was simply never found.

## Investigation

`~/.codex/sessions` held 690 rollouts, none newer than 8 August — while the live session was writing to `~/.dev3.0/agent-accounts/codex/<accountId>/sessions/2026/08/21/rollout-*.jsonl`. dev3's agent-accounts feature points `CODEX_HOME` at a per-account directory, and Codex stores its sessions relative to that, so every Codex session launched from a task under an account is invisible to a scan of the home store. The same blind spot applied to `dev3 conversations search`, which shares the locator.

## Decision

`codexSessionRoots()` in `src/bun/conversation-search.ts` now returns the home store *plus* every `~/.dev3.0/agent-accounts/codex/*/sessions` directory, and `codexLocator.buildIndex` indexes all of them by the `cwd` in each rollout's `session_meta` header. Absent directories are normal and skipped; the index is `null` only when no root exists at all. Covered by two tests in `src/bun/__tests__/conversation-parse.test.ts` (account-only, and account plus home side by side), both verified to fail when the account root is removed.

## Risks

- The account layout is dev3's own, so it cannot drift silently; if Codex changes where it writes under `CODEX_HOME`, the symptom is again "no Codex sessions found" rather than bad data.
- Indexing more roots means reading the first line of more files per search. Bounded by the number of accounts, which is small.

## Alternatives considered

- **Read `CODEX_HOME` from the environment** — rejected: the CLI runs outside the agent's process, so it would see its own environment, not the one the session was launched with.
- **Record the transcript path on the task at launch** — better long term and still open, but it would only help sessions started after the change; scanning finds the ones already on disk.
