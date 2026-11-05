# Rebind a native main agent's scheduled messages after a restart

## 1. Context
On tmux a resumed agent lives in a NEW pane or server, so the pane id or `paneToken` (server token) changes and `resolveScheduledMessageAuthorPane` can tell a restart from "the agent exited into its shell". A native pane keeps its id (`pane-1`) and its registry session id (`<coordinator>-pane-1`) across a restart, so that test never fires and the message was always dropped (`decisions/2026/10/06/scheduled-self-reminder-author-binding.md`).

## 2. Decision
`ScheduledMessageAuthor` gains an optional `paneGeneration`: the start signature of pane-1's root process, stored for the native main agent only. A restart runs under a new root; an agent that exited leaves a handed-over shell under the same root (`exec`). `resolveNativeMainAuthor` (`src/bun/scheduled-message-author.ts`) rebinds to pane-1 only when the author is pane-1, its `sessionId` equals the first, non-parked `sessionState` entry (recorded without a pane id on native), the root is not a bare shell and has a non-shell child, and the root PID differs from the stored one. Anything else, including a record without `paneGeneration`, is dropped as before. The generation is read only where it is stored or compared: self-message and PR-watch capture, and held task-addressed targets (which now survive a restart). `paneToken`, `agentProcess` and the agent handle are unchanged.

## 3. Risks
Agent handles do not carry `paneGeneration`, so `--agent <handle>` scheduled messages and envelope replies still do not rebind on native. Start Fresh keeps the registry id but writes a new conversation id, so the `sessionId` check drops it. An agent restarted under the same root by a retry wrapper counts as the same generation and is dropped. Older apps ignore the field and keep comparing `paneToken`; newer apps drop older records that lack it.

## 4. Alternatives considered
Changing `paneToken` for native (for example appending the root signature): rejected, older versions compare it while the agent is alive, so stored authors would break across versions (N-2 readability). Adding the field to the handle: changes the encoding for every consumer. Trusting `paneRunsAgent` alone: accepts any program running in a shell the agent left behind.
