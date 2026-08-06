# 190 — Native agent-prompt delivery: `pane-1` is the agent, and the delivery goes to whoever holds the pen

## Context

`dev3 message`, scheduled "Send later" messages, and the Create-PR / commit /
rebase-conflict hand-offs all typed their text into a task's agent through
`sendPromptToAgentPane` — pure tmux: list the session's panes, cross-reference
`sessionState.panes`, `send-keys`. A task running on the native terminal backend
has no tmux session, so pane resolution returned `null` and every send failed
with `Could not deliver the message — the task has no live agent session.` while
the agent was demonstrably alive (seq 1371; reproduced against a live three-pane
native task).

## Investigation

The live coordinator record of the failing task (`~/.dev3.0/native-multipane/
dev3-task-<id>/coordinator.json`) plus the three pane records showed the shape
the fix has to rely on:

- `pane-1`'s shell is `zsh /tmp/dev3-<taskId>-run.sh` — the agent wrapper.
- `pane-2` / `pane-3` are bare `zsh` splits.
- `activePaneId` was `pane-2`, i.e. a **shell**, so any focus-following
  heuristic would have typed the prompt into a shell prompt.
- `sessionState.panes[0]` exists but carries no `paneId` (that field is a tmux
  pane id and is never populated on the native path).

## Decision

Three invariants, encoded in `src/bun/agent-prompt-native.ts`:

1. **Discovery is structural, not heuristic.** The agent runs in the
   coordinator's first pane: `startNativeTaskPanes` launches the agent wrapper
   there, and every split created by `nativePaneAction` is a plain shell (it
   never passes a launch spec). `createSplitTree` names that pane `pane-1`
   deterministically, and `NativeMultipaneCoordinator.recover()` reconciles dead
   panes out of the tree. So *"`pane-1` is in the pane set and alive"* is exactly
   *"the agent is running"* — `NATIVE_AGENT_PANE_ID` plus a liveness check, no
   focus tracking and no `pane_current_command` sniffing. Discovery reads the
   coordinator from disk, so every app process answers the same.
2. **Ownership is resolved from the host, never assumed.** A binding is not
   permission to write (decision 191): the host grants the writer lease to one
   client across all dev3 processes and silently drops an observer's input.
   Delivery binds the pane on demand (`reattachNativeTaskSession` for the agent
   pane, `ensureNativePanePtySession` for the rest — neither spawns), then asks
   `resolvePaneOwner`. `local` writes here; `vacant` claims the lease first;
   `unknown` and `gone` are reported as undelivered rather than guessed at.
3. **The delivery travels, not the bytes — and the owner side is a dead end.**
   A `peer` owner receives the WHOLE delivery over the internal CLI-socket method
   `_native.deliverPrompt` and performs it once; the forwarding process writes
   nothing itself. The owner-side entry point `deliverNativePromptAsOwner`
   resolves no owner and forwards nothing, so a stale answer can never bounce one
   message between two processes. That pair — forward-whole-delivery plus a
   non-forwarding owner side — is what makes it exactly once.

Routing lives in `src/bun/agent-prompt-delivery.ts` (`deliverAgentPrompt`) — the
single seam now used by immediate sends, scheduled fires, and all three git
hand-offs. A native task never falls back to tmux, and a task with an unreadable
`terminalBackend` marker throws rather than guessing.

Proven end to end by `bun run test:native-message-e2e`: two real app processes
over one isolated dev3 home, message entering the non-owner, landing exactly once
in `pane-1`, host and shell pids unchanged, one registry session, and a tmux
sentinel untouched.

## Risks

- If a future feature launches an agent into a native **split**, that agent is
  invisible to discovery. The mitigating fact is that the split path is
  shell-only by construction today; a change there must extend this rule (record
  which panes are agent panes) in the same commit.
- A forward that times out (`forwardToOwner`, 10 s) is reported as undelivered
  while the owner may still have performed it. At-most-once is preserved on the
  sender side, but a caller must not retry blindly on a timeout.
- `\r` is assumed to be the submit keypress for every agent CLI on a native PTY.
  That matches what tmux's `Enter` sends; a TUI wanting something else would
  need a per-agent submit key.

## Alternatives considered

- **Route native writes through `TerminalBackend.attachView().write()`.** The
  clean-looking option, and wrong: a second client attaches as an observer and
  the host discards the keystrokes with no error the caller can see.
- **Claim the lease whenever we want to type.** Rejected: it steals the pane out
  from under whoever is actually typing in it. Claiming is limited to a lease the
  host reports as vacant.
- **Forward the bytes instead of the delivery.** Would split one submit across
  two processes and make exactly-once depend on timing.
- **Reuse the tmux focus heuristic over native panes.** Rejected by the live
  data above — the active pane was a shell.
- **Make `sessionState.panes[].paneId` hold native pane ids.** Would mean two
  meanings for one field plus a write path on every pane change, to reproduce
  information that is already deterministic.
