# Agent exit report for every harness, keyed by a per-launch id

## Context
The launch wrapper's `dev3 hook agent-exited` report was wired only for a fresh Claude launch with a pre-assigned session id and dev3's SessionStart hook installed. Any other agent that died (Codex failing to load its cloud config bundle at 05:11, exit 1) left its card on "Agent is Working" forever — including automation-launched tasks, so a failed scheduled run was invisible.

## Decision
`launchTaskPty` (`src/bun/rpc-handlers/tmux-pty/task-launch.ts`) mints a random launch id for every agent launch that is not on the Claude receipt path (resumes, non-Claude harnesses, Claude without the hook) and bakes the same exit report into the wrapper, so tmux and native (PowerShell) launches both get it. `src/bun/agent-session-receipts.ts` records `startReceipts` per launch and the latest launch id per task; `noteAgentExited` returns a verdict: `early` (receipt harness, exit before SessionStart, any code) or `crashed` (non-zero, any harness). Only the task's latest launch from this app process can move the card, so a stale wrapper is ignored. The `agent.exited` handler moves an in-progress, non-hibernated card to `user-questions` with an attention badge naming the code. A started Claude session that exits non-zero now also moves the card.

## Risks
In memory only: an app restart between launch and exit forgets the launch and the report is ignored (same as before for Claude). An agent that exits non-zero by design on user quit would land in Has Questions; known harnesses exit 0 on a normal quit. The wire flag stays `--session` so the managed CLI copy keeps working unchanged.

## Alternatives considered
- Persist the launch id on the task (`sessionState`) to survive restarts: an on-disk field read by older app versions for a rare window; deferred.
- Attribute by pane id (`TMUX_PANE` / `DEV3_PANE_ID`): pane ids are reused across sessions and differ per backend, so a stale report could match a newer pane.
- Only cover harnesses without hooks (skip Claude crashes after start): leaves the same stuck-card bug for Claude mid-session crashes.
