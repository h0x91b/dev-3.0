import { useEffect, useRef } from "react";

/**
 * Close an overlay (modal / lightbox / popover) when Escape is pressed.
 *
 * Registers a **capture-phase** `window` keydown listener while `enabled` and,
 * on Escape, calls:
 *   - `e.preventDefault()` — so the key never reaches macOS/WKWebView, which
 *     would otherwise treat Escape as `cancelOperation:` and exit the app's
 *     native fullscreen *instead of* closing the overlay. This is the bug this
 *     hook exists to fix: without preventDefault, an unconsumed Escape bubbles
 *     out of the web view to AppKit and drops you out of fullscreen.
 *   - `e.stopImmediatePropagation()` — so the app-level back-navigation Escape
 *     handler (and any other window listener) does not also fire.
 *
 * Capture phase is required so this beats App's global (bubble-phase) handler
 * and any focused element. As a consequence, descendant element-level Escape
 * handlers are pre-empted — overlays with an inner sub-state that should be
 * dismissed first (an open dropdown, an inline rename, an autocomplete popup)
 * must encode that staging inside `onEscape` rather than relying on a child's
 * own handler.
 *
 * The callback is read through a ref, so it is always current without needing a
 * dependency array — only `enabled` gates the listener.
 *
 * @example
 *   useEscapeKey(onClose);                       // simple modal
 *   useEscapeKey(() => menuOpen ? closeMenu() : onClose()); // staged
 *   useEscapeKey(onClose, { enabled: popoverOpen });        // gated popover
 */
export function useEscapeKey(
	onEscape: () => void,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const onEscapeRef = useRef(onEscape);
	onEscapeRef.current = onEscape;

	useEffect(() => {
		if (!enabled) return;
		function handleKey(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopImmediatePropagation();
			onEscapeRef.current();
		}
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, [enabled]);
}
