import { useEffect, useRef } from "react";
import {
	BACK_SENTINEL_STATE,
	closeTopBackLayer,
	createBackPressHandler,
	isBackSentinelState,
} from "../back-navigation";

/**
 * Wire the Android hardware/gesture Back button to in-app navigation
 * (mobile remote mode only — enable on the mobile breakpoint outside
 * Electrobun).
 *
 * Pushes a sentinel history entry on mount; a Back press pops it and the
 * popstate handler goes Android-style: close the topmost layered surface
 * first, else route back, else arm double-back-to-exit (toast; a second
 * press within ~2s leaves the app for real). With the soft keyboard open,
 * Android consumes Back to dismiss the keyboard before any history
 * navigation — no popstate fires, which is exactly the wanted behavior.
 */
export function useAndroidBackGuard(opts: {
	enabled: boolean;
	/** Navigate the in-app route history back; return false at the root. */
	routeBack: () => boolean;
	/** Show the "press Back again to exit" toast. */
	showExitToast: () => void;
}) {
	const routeBackRef = useRef(opts.routeBack);
	routeBackRef.current = opts.routeBack;
	const showExitToastRef = useRef(opts.showExitToast);
	showExitToastRef.current = opts.showExitToast;

	useEffect(() => {
		if (!opts.enabled) return;

		const armSentinel = () => {
			try {
				window.history.pushState(BACK_SENTINEL_STATE, "");
			} catch {
				/* history API blocked (rare embedded contexts) — guard degrades to no-op */
			}
		};

		const handleBackPress = createBackPressHandler({
			closeTopLayer: closeTopBackLayer,
			routeBack: () => routeBackRef.current(),
			showExitToast: () => showExitToastRef.current(),
			armSentinel,
			scheduleRearm: (cb, ms) => {
				window.setTimeout(cb, ms);
			},
		});

		armSentinel();

		const onPopState = (e: PopStateEvent) => {
			// A forward navigation INTO the sentinel entry (e.g. swipe-forward)
			// is not a Back press — the guard is simply re-armed by it.
			if (isBackSentinelState(e.state)) return;
			handleBackPress();
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [opts.enabled]);
}
