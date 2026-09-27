# Batch a held backlog into one file, and clock the user's typing per task

## Context

On 2026-09-26 a coordinator (Codex, Seq 22 of another project) received 33 queued `dev3 message`s one per minute; the last one was typed 31 min 50 s after it was sent, long after its sender had completed. The app log proved the delay was the hold itself: every envelope was 500–990 bytes, so `burstFitCount` let one release carry one message; the leftover waited a full quiet window; and `requeue` copied `humanHeld` into every continuation, so one keystroke made each of the 33 steps wait 60 s. The receiver finished each turn in about 5 s. Diagnosis by Seq 2013 (its report is kept outside the repo), design reviewed by Seq 2003.

## Decision

- **B — batch.** When the held messages do not fit one terminal read and the adapter supplies `batch`, `planRelease` (`src/bun/agent-message-hold.ts`) takes up to `AGENT_MESSAGE_BATCH_MAX_MESSAGES` (50) and `AGENT_MESSAGE_BATCH_MAX_BYTES` (256 KB), oldest first. `spillHeldMessageBatch` (`src/bun/agent-message-spill.ts`) writes their exact typed texts to `<taskDir>/messages/burst-*.md`, and ONE `<dev3-ai-message>` pointer (`wrapHeldBatchPointer`, which shortens the sender list before it would ever cut the path) is typed as one turn. A burst that fits is typed exactly as before. A write failure, or a pointer that cannot fit, falls back to one turn per read.
- The pointer is a step that stands for its originals: copy mode puts the ORIGINALS back and `discard`s the refused batch (file unlinked, its receipt taken back by exact text with `retractDev3TypedPrompt`), so a pane left scrolled up does not leave a file and a receipt every quiet window — review found 40 files in 10 min, and 64 receipts is the per-task cap; a stranded pointer is released only by a submission containing the pointer; a drop names the batch file. Both adapters leave a `noteDev3TypedPrompt` receipt for the pointer.
- **H1 — the typing clock.** `humanHeld` is gone. `lastHumanInputAt` records each task's last keystroke even when nothing is held, and `delayFor` waits `max(message rule, what is left of 60 s after that keystroke)`. The user's own Enter clears it. A keystroke during a release still delays what the release leaves; an old one no longer multiplies across turns.
- Spill files get a random suffix and are created with `wx`: two spills in one millisecond overwrote each other.

## Risks

- An agent may skim a large batch and act on stale items; the pointer says "oldest first", filtering is out of scope.
- An owner-routed native delivery (`deliverNativePromptAsOwner`) knows only the task id, so its backlog keeps one turn per read, now paced by the clock.
- The live batch-read check ran on a build before this change: Codex (Bypass) and Claude acted on all 6 messages of a hand-built batch; sandboxed Codex failed to launch at all on the test machine, so its read access is unmeasured.

## Alternatives considered

- Raising the 1 000-byte cap: reintroduces the lost first chunk of #1608.
- Pacing releases on the receiver's `Stop` hook: lifecycle plumbing owned by the readiness work, Claude/Codex only.
- Only resetting `humanHeld` on continuations: 33 turns × 15 s is still 8.5 min, and a keystroke during a release would be lost.
