import { useEffect, useRef, type RefObject } from "react";
import { registerOverlayLayer } from "./overlay-layers";

/**
 * Wire a portalled panel (dropdown / anchored popover / menu) into the app's
 * overlay-layer stack so Tab reaches it, Escape dismisses it before the
 * surrounding modal, and moving focus away closes it.
 *
 * Use this INSTEAD of `useEscapeKey` in a portalled panel — see
 * `utils/overlay-layers.ts` for why a panel's own Escape listener loses to the
 * modal that opened it.
 *
 * @param panelRef  the portalled panel element
 * @param onDismiss close the panel (also runs on Escape and on focus leaving)
 * @param triggerRef the control that opened it; focus landing there is "inside"
 * @param autoFocus  move focus to the panel's first focusable on mount. Off by
 *                   default: components with their own roving focus (a listbox
 *                   with `aria-activedescendant`) keep focus on the trigger.
 */
export function useOverlayLayer(
	panelRef: RefObject<HTMLElement | null>,
	{
		onDismiss,
		triggerRef,
		autoFocus = false,
	}: {
		onDismiss: () => void;
		triggerRef?: RefObject<HTMLElement | null>;
		autoFocus?: boolean;
	},
): void {
	// Read through a ref so a re-rendered closure never leaves the stack holding
	// a stale dismiss callback.
	const dismissRef = useRef(onDismiss);
	dismissRef.current = onDismiss;

	useEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;

		const unregister = registerOverlayLayer(panel, () => dismissRef.current());

		if (autoFocus) {
			panel.querySelector<HTMLElement>("[data-overlay-autofocus]")?.focus();
		}

		// Keyboard dismissal on the way out: the document-level `mousedown`
		// handlers each panel already has only cover the pointer.
		function onFocusOut(e: FocusEvent) {
			const next = e.relatedTarget as Node | null;
			if (!next) return;
			if (panel?.contains(next)) return;
			if (triggerRef?.current?.contains(next)) return;
			dismissRef.current();
		}
		panel.addEventListener("focusout", onFocusOut);
		return () => {
			panel.removeEventListener("focusout", onFocusOut);
			unregister();
		};
	// The panel element identity is stable for the panel's lifetime, and
	// onDismiss is read at dismissal time via the registered closure.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}
