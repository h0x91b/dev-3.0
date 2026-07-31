/**
 * The stack of open portalled overlay panels (dropdowns, popovers, anchored
 * menus) that live outside the DOM subtree of whatever opened them.
 *
 * Two problems this solves, both of which used to be re-solved per component:
 *
 *  1. **Focus.** `useFocusTrap` cycles Tab within the dialog container, but a
 *     `createPortal(…, document.body)` panel is a sibling of that container, so
 *     its rows were unreachable — the trap pulled focus straight back into the
 *     dialog. The trap now also walks every registered layer.
 *  2. **Escape.** `useEscapeKey` is capture-phase + `stopImmediatePropagation`,
 *     so the listener registered FIRST wins — and a modal always mounts before
 *     the popover inside it. Escape therefore closed the whole dialog instead of
 *     the dropdown on top of it. `useEscapeKey` now dismisses the innermost
 *     layer first, and this module keeps its own listener for panels opened
 *     without any surrounding modal.
 *
 * Portalled panels register through `useOverlayLayer` and must NOT call
 * `useEscapeKey` themselves.
 */

interface OverlayLayer {
	el: HTMLElement;
	onDismiss: () => void;
}

const layers: OverlayLayer[] = [];
let listening = false;

function handleKey(e: KeyboardEvent) {
	if (e.key !== "Escape" || layers.length === 0) return;
	e.preventDefault();
	e.stopImmediatePropagation();
	dismissTopOverlayLayer();
}

function syncListener() {
	if (layers.length > 0 && !listening) {
		window.addEventListener("keydown", handleKey, true);
		listening = true;
	} else if (layers.length === 0 && listening) {
		window.removeEventListener("keydown", handleKey, true);
		listening = false;
	}
}

/** Push a panel onto the stack. Returns the unregister function. */
export function registerOverlayLayer(el: HTMLElement, onDismiss: () => void): () => void {
	const layer: OverlayLayer = { el, onDismiss };
	layers.push(layer);
	syncListener();
	return () => {
		const index = layers.indexOf(layer);
		if (index !== -1) layers.splice(index, 1);
		syncListener();
	};
}

/** Every currently-open panel, outermost first. Read by `useFocusTrap`. */
export function getOverlayLayerElements(): HTMLElement[] {
	return layers.map((l) => l.el);
}

/** Dismiss the innermost open panel. Returns false when the stack is empty, so
 *  an Escape handler knows to fall through to closing itself. */
export function dismissTopOverlayLayer(): boolean {
	const top = layers[layers.length - 1];
	if (!top) return false;
	top.onDismiss();
	return true;
}
