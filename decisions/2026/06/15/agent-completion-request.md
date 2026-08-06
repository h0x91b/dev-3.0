# 067 — Agent-initiated task completion via blocking CLI approval

## Context

Only the user could move a task to `completed` (it destroys the worktree + tmux session); the CLI blocked it client-side in `DESTRUCTIVE_STATUSES`. Agents needed a way to signal "I'm fully done" — without being able to silently kill their own session. The agent must also learn from the CLI response whether the user approved or declined.

## Decision

`dev3 task move --status completed` now sends `task.requestCompletion` over the CLI socket and **blocks up to 10 minutes** (client-side timeout, `src/cli/commands/task.ts` → `requestCompletion`). The bun handler (`src/bun/cli-socket-server.ts`) registers a pending request in `src/bun/completion-requests.ts` and pushes `agentCompletionRequested` to the renderer, which shows a danger-styled `confirm()` with an "AI agent request" badge and accent border (`agentInitiated` option in `src/mainview/confirm.tsx`, listener in `App.tsx`). The renderer answers via the `respondToAgentCompletionRequest` RPC; on approve the handler runs the normal `moveTask` → completed, on decline the CLI exits with the new documented code 6 (`CLI_EXIT_CODE_COMPLETION_DECLINED`). `cancelled` stays fully forbidden via CLI.

## Risks

- Pending requests are in-memory only (user chose no persistence): an app restart drops the dialog and the CLI times out. Acceptable — the agent can simply retry.
- No server-side timeout: if the CLI dies, the dialog stays; a later user approval still completes the task (the write to the dead socket fails harmlessly). This is intentional — an AFK user's approval must not be lost.
- A repeat request for the same task joins the existing pending decision (`isNew` flag) instead of spawning a duplicate dialog.

## Alternatives considered

- New command `dev3 task request-completion` — rejected; agents already know `task move`, reuse keeps the surface minimal.
- Fire-and-forget push + persisted board badge — rejected by the user; live blocking dialog only, agent gets the verdict in the same invocation.
- Auto-adding a note on decline — rejected by the user; the exit-code-6 message tells the agent to keep working.
