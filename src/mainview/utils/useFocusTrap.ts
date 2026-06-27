import { useEffect, useRef, type RefObject } from "react";

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

function getFocusable(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => el.getAttribute("aria-hidden") !== "true",
	);
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
			const inside = container.contains(active);

			if (e.shiftKey) {
				if (!inside || active === container || active === first) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (!inside || active === container || active === last) {
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
