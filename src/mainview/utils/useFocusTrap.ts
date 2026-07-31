import { useEffect, useRef, type RefObject } from "react";
import { getOverlayLayerElements } from "./overlay-layers";

/**
 * Selector for natively-focusable / tabbable elements. Mirrors the common
 * "tabbable" set: links with href, enabled form controls, and anything with a
 * non-negative tabindex. Elements with tabindex="-1" are focusable only
 * programmatically, so they're excluded from the Tab ring.
 */
const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

function collect(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		// A `button` with tabindex="-1" still matches the selector above but is not
		// tabbable — that is how a roving-focus listbox marks its rows.
		(el) => el.getAttribute("aria-hidden") !== "true" && el.tabIndex >= 0,
	);
}

/**
 * The innermost open portalled panel, when it has rows of its own to tab
 * through. `Select` keeps focus on its trigger and roves with
 * `aria-activedescendant`, so its options are `tabindex="-1"` and it deliberately
 * yields nothing here. See `utils/overlay-layers.ts`.
 */
function tabbablePanel(container: HTMLElement): HTMLElement[] | null {
	const layers = getOverlayLayerElements().filter((el) => !container.contains(el));
	const top = layers[layers.length - 1];
	if (!top) return null;
	const rows = collect(top);
	return rows.length > 0 ? rows : null;
}

/**
 * While a portalled panel is open the ring narrows to that panel — Tab cycles
 * its rows instead of walking the dialog behind it, exactly as a dialog captures
 * Tab from the page. Unioning both would technically reach the rows, but only
 * after tabbing through the whole dialog, and it would let the user operate
 * controls the panel covers.
 */
function getFocusable(container: HTMLElement): HTMLElement[] {
	return tabbablePanel(container) ?? collect(container);
}

/**
 * Keeps keyboard focus inside a modal/dialog while it is mounted.
 *
 * Without a trap, Tab/Shift+Tab walk straight out of the modal into the page
 * behind it (task cards, labels, etc.), which is both confusing and lets the
 * user operate hidden UI. This hook:
 *   1. moves focus into the dialog container on mount (unless something inside
 *      already grabbed it, e.g. an `autoFocus` input),
 *   2. cycles Tab / Shift+Tab within the container's focusable elements,
 *   3. restores focus to whatever was focused before the dialog opened.
 *
 * Attach the returned ref to the dialog container element. The container should
 * be focusable itself (`tabIndex={-1}`) so step 1 has a target even when the
 * dialog has no focusable children yet.
 *
 * Works identically in the Electrobun desktop shell and the browser remote mode.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(): RefObject<T | null> {
	const ref = useRef<T>(null);

	// Capture the trigger element at first render — before the dialog mounts and
	// before any `autoFocus` child runs — so focus can be restored on close.
	const previouslyFocused = useRef<Element | null>(null);
	if (previouslyFocused.current === null) {
		previouslyFocused.current = document.activeElement;
	}

	useEffect(() => {
		const container = ref.current;
		if (!container) return;

		// Pull focus into the dialog so the very first Tab is already trapped —
		// but don't steal it from an element inside that's already focused (an
		// autoFocus input, a programmatically-focused field).
		if (!container.contains(document.activeElement)) {
			container.focus();
		}

		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Tab" || !container) return;

			const focusables = getFocusable(container);
			if (focusables.length === 0) {
				// Nothing to focus inside — keep focus on the container itself.
				e.preventDefault();
				return;
			}

			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			const active = document.activeElement;

			// An open panel owns the ring. Focus still on its trigger (or anywhere
			// else in the dialog) is pulled straight into the panel, so the very
			// first Tab after opening a popover lands on one of its rows.
			const panel = tabbablePanel(container);
			if (panel && !panel.includes(active as HTMLElement)) {
				e.preventDefault();
				(e.shiftKey ? last : first).focus();
				return;
			}

			const inside = panel ? true : container.contains(active);

			if (e.shiftKey) {
				// Backward: wrap to the last element at the first element, the
				// container, or if focus has escaped the dialog.
				if (active === first || active === container || !inside) {
					e.preventDefault();
					last.focus();
				}
			} else {
				// Forward: wrap to the first element only at the last element or if
				// focus escaped. When the container ITSELF holds focus (dialog just
				// opened), DON'T preventDefault — let the browser Tab natively into
				// the first child. A native Tab reliably triggers :focus-visible,
				// whereas a programmatic .focus() from the (non-focus-visible)
				// container does not, which left the very first Tab showing no ring.
				if (active === last || (!inside && active !== container)) {
					e.preventDefault();
					first.focus();
				}
			}
		}

		// Capture phase so the trap wins regardless of other keydown listeners.
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			// Return focus to where the user was before the dialog opened.
			(previouslyFocused.current as HTMLElement | null)?.focus?.();
		};
	}, []);

	return ref;
}
