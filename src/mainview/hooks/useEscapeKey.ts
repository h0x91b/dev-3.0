import { useEffect, useRef } from "react";
import { registerBackLayer } from "../back-navigation";
import { dismissTopOverlayLayer } from "../utils/overlay-layers";

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
 * and any focused element. Portalled panels registered via `useOverlayLayer`
 * are dismissed first automatically, so a dropdown or popover inside a modal
 * needs no staging at the call site. Non-portalled inner sub-state (an inline
 * rename, an autocomplete inside a field) still has to encode its own staging
 * inside `onEscape`, since a descendant's element-level handler is pre-empted.
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
			// A portalled dropdown / popover sitting on top of this overlay is
			// dismissed first. Registration order alone would close THIS overlay
			// (a modal always mounts before the popover inside it) and throw away
			// whatever the user had configured — see utils/overlay-layers.ts.
			if (dismissTopOverlayLayer()) return;
			onEscapeRef.current();
		}
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, [enabled]);

	// Any Esc-closable overlay is also closable by the Android hardware Back
	// button (mobile remote mode): register it in the back-layer stack for the
	// same lifetime. The stack is inert outside the mobile back guard.
	useEffect(() => {
		if (!enabled) return;
		return registerBackLayer(() => onEscapeRef.current());
	}, [enabled]);
}
