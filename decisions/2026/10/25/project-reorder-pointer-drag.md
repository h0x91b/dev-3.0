# Dashboard project reorder uses pointer events, not HTML5 drag

## Context
h0x91b/dev-3.0#2042: dragging a project on the dashboard gave no landing position, the preview was a full card over a list of one-line rows, and a successful drop played a fly-back to the original slot before the new order appeared.

## Investigation
All three came from native HTML5 drag. The OS ghost is captured in `dragstart`, before the list may collapse (collapsing inside `dragstart` kills the drag, see #1906), so it is always the expanded card. It covered the 2px insertion line drawn at the edge of the row under it. Releasing over the 16px gap between rows hit no drop target, and the macOS slide-back animation plays in WebKit independently of what the page does. The space-group path also waited for the `spacesUpdated` push before showing the new order.

## Decision
`src/mainview/hooks/useReorderDrag.ts` drives the grip with pointer events and pointer capture. After a 4px threshold the scope collapses, the dragged row becomes a dashed placeholder (`data-reorder-placeholder`), and a cloned compact row follows the pointer. The other rows get `translateY` from spans measured once at start (`src/mainview/utils/reorderGeometry.ts`), so the gap opens where the row will land, and auto-scroll runs near the scroller's edges. On release the clone settles into that slot, then the order is committed optimistically (`SpaceGroupedProjects` keeps a pending order until the push matches) and the list expands with the dropped row anchored in place. Escape, `pointercancel` and window blur return it to the origin. The Escape listener is installed at module import: `useEscapeKey` overlays stop immediate propagation from their own window capture listeners, and the earliest-registered listener wins.

## Risks
The browser no longer auto-scrolls for us; `autoScroll` covers the list's own scroller only. Row transforms are written to the DOM directly and must stay off React's `style` prop for these rows.

## Alternatives considered
Keeping HTML5 drag with a transparent drag image and an in-page overlay: still at the mercy of WebKit's slide-back timing, `dragover` firing only on mouse moves, and dead gaps. A library (dnd-kit): a new dependency for one list, and the npm mirror makes adding one costly.
