# 164 — Client-local focus/zoom is a pure overlay on the shared pane set

## Context

The tmux-removal roadmap replaces one shared tmux layout with a native host
that fans one PTY to several local clients (decisions 158, 160). SplitTree
(`src/shared/split-tree.ts`) still bakes `activePaneId`/`zoomedPaneId` into the
one shared tree, which cannot express per-client focus. LAY-005 needs the state
law for per-client focus/zoom proven before any renderer, host, or adapter uses
it.

## Decision

`src/shared/native-terminal-client-layout/index.ts` models each client's view
as `{ paneIds, focusedPaneId, zoomedPaneId }` — the shared ordered pane set plus
two client-local overlays. Focus and zoom are **orthogonal**: zoom does not move
focus and focus does not clear zoom, so a client can zoom a pane other than the
focused one. Every function is pure, immutable, and returns the same reference
on a no-op; the module is import-free with no PTY dimension anywhere.

Reconciliation is deterministic: a still-present focus/zoom is kept; a removed
zoom target clears zoom; a removed/invalid focus falls back to the nearest
surviving pane **after** the old focus in the previous order, else the nearest
before it, else the first pane; an empty set has null focus. This keeps the
invariant `focus === null ⇔ paneIds is empty`, verified by
`validateClientPaneLayout`.

## Risks

Orthogonal focus/zoom diverges from SplitTree, where zoom follows the active
pane. A future adapter (Seq 1254) must map deliberately between the two rather
than assume zoom implies focus. The overlay stores its own last-seen pane order
to compute neighbor fallback; a caller that skips `reconcile` on a shared-set
change can leave a stale focus until the next reconcile.

## Alternatives considered

Storing focus/zoom only (no pane-order snapshot) was rejected because neighbor
fallback then loses adjacency and can only jump to the first pane. Coupling zoom
to focus (SplitTree's rule) was rejected as it hides two independent client
choices behind one field and complicates observer-isolation proofs. Extending
SplitTree with per-client fields was rejected: it would mutate the frozen shared
model this ticket must not touch.
