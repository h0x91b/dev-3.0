# 198 — Oversized review payloads spill to a file next to the worktree

## Context

The diff viewer's "Send review to agent" and the GitHub PR-thread "Send to agent"
button both hand the composed text to `sendAgentMessageNow`. Once a review carries
enough comments, the send fails and the reviewer has to do the workaround by hand:
dump the text into a file and paste the path into the agent instead.

## Investigation

Traced every hop from the button to the terminal:

| Hop | Limit |
|---|---|
| `TaskDiffViewer.handleSendReviewToAgent` / `sendThreadToAgent` | none |
| `rpc-handlers/pr-comments.ts` → `sendAgentMessageNow` | none |
| `scheduled-message-scheduler.ts` → `validateText` | **`MAX_SCHEDULED_MESSAGE_LENGTH` = 10 000 chars — throws** |
| tmux `send-keys` argv (`tmux/client.ts`) | OS `ARG_MAX`, ~1 MB on macOS |
| native PTY WebSocket frame (`native-terminal-registry/client.ts`) | no app-level cap, WS fragments |

So the binding constraint is our own guard, not the agent's paste path or tmux.
Neither transport chunks the text, but neither is reached — `validateText` rejects
first.

## Decision

`sendAgentMessageNow` (`src/bun/rpc-handlers/pr-comments.ts`) now checks the
trimmed payload against `AGENT_MESSAGE_SPILL_THRESHOLD` (`src/shared/types.ts`,
8 000 chars = the 10 000 guard minus a 20% margin). Over it, the payload is written
to `<taskDir>/reviews/review-<iso-timestamp>.md` and the agent receives a two-line
pointer naming that path. The RPC returns `{ spilledPath: string | null }` so the
toast can say where the file went.

The spill lives **next to** the git worktree, not inside it (`taskDir()` returns
`~/.dev3.0/worktrees/<slug>/<shortId>`, the worktree is its `worktree/` child): a
file inside the worktree would show up untracked in `git status` and inside the very
diff viewer that produced it, and could get committed. It is removed with the task
directory on cleanup.

Doing this in the RPC handler rather than the renderer means every caller — batch
send, PR-thread send, and the per-comment send tracked separately — inherits it
with no per-call-site logic.

## Risks

- The file is written before delivery, so a send that fails on "no live agent"
  leaves an orphan review file in the task directory. It is cheap, task-scoped, and
  cleaned with the worktree.
- The threshold is static. If `MAX_SCHEDULED_MESSAGE_LENGTH` ever changes, the
  margin has to be revisited; the constant's docstring points at it.

## Alternatives considered

- **Chunk the text across several sends.** Multiple pastes into one agent prompt
  race the 800 ms Enter delay and can submit a half-typed review.
- **Raise `MAX_SCHEDULED_MESSAGE_LENGTH`.** The guard also protects scheduled
  messages persisted in `tasks.json` and the CLI's `dev3 message` exit-code
  contract; pasting a 50 KB blob into an agent prompt is bad UX regardless.
- **Spill in the renderer.** Would need a file-writing RPC anyway and duplicate the
  logic across every send button.
