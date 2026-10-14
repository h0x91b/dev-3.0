# An agent-message burst stacks as a deck with an exact count

## Context

Agent toasts keep one slot, and each new `dev3 message` replaces the previous one in place (`decisions/2026/10/08/agent-message-toast-card-opens-the-sender.md`). In a burst, only the latest message stays on screen, and nothing shows that earlier ones were covered. The user compared three prototypes (deck, envelope tally, digest row) and picked the deck.

## Investigation

Reproduced on an isolated QA board by dispatching `rpc:agentMessage` locally: after five messages the toast looked like one. The count has to be "messages the slot covered", not unread: Agent traffic has no read state, and the toast never removes anything from it. While immersive fullscreen suppresses toasts, the pending queue keeps only the newest 5 entries, so counting rendered toasts would undercount a long burst.

## Decision

- `ToastHost` (`src/mainview/toast.tsx`) carries `earlier` (per-pair counts, from `burstKey`) on the replacing toast via `coverBurst()`, plus a `slotId` that outlives each card. The count resets when the slot empties: X, swipe, Clear all, acting, timeout, eviction.
- `queuePending()` coalesces queued agent entries, so the count stays exact after suppression.
- The slot renders up to two deck layers (one when narrow) inside the 10 px stack gap, `pointer-events-none`. A `+N earlier` tab hangs on the bottom edge, with a per-pair tooltip below it. Nothing moves, so the 600 ms arm guard holds, and each replacement still remounts the card. Continuations enter with a short nudge instead of the full slide.
- The card stays `role="alert"` and adds an sr-only burst summary. The prototype's polite region was dropped, because a freshly mounted polite region is often not announced at all. X reads "Dismiss N messages".

## Risks

The layers are 5–10 px, so on a busy background they rely on border and shadow. Burst pairs are labelled by seq, so two cross-board pairs with equal seqs and the same board name would merge. A queued burst that 5 newer non-agent toasts push out of the pending queue is still lost from the toast, though it remains in traffic, as before.

## Alternatives considered

Envelope tally badge: a number on an envelope reads as unread mail. Digest row: adds height and a new disclosure pattern inside a toast, a step toward a notification centre. Per-pair slots or a reset when the pair changes: would hide covered messages again.
