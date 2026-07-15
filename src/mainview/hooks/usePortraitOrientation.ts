import { useEffect, useState } from "react";

const LANDSCAPE_QUERY = "(orientation: landscape)";

/** Return whether the current viewport is wider than it is tall. */
export function isLandscapeViewport(): boolean {
	return typeof window !== "undefined"
		&& typeof window.matchMedia === "function"
		&& window.matchMedia(LANDSCAPE_QUERY).matches;
}

/**
 * Ask the browser to keep a mobile document in portrait orientation.
 * Browsers may reject this outside fullscreen or when the API is unsupported;
 * the caller must keep a visible fallback for that case.
 */
export async function requestPortraitLock(): Promise<boolean> {
	if (typeof window === "undefined") return false;
	const orientation = window.screen?.orientation;
	if (!orientation || typeof orientation.lock !== "function") return false;

	try {
		await orientation.lock("portrait");
		return true;
	} catch {
		return false;
	}
}

/**
 * Track a mobile viewport's orientation and retry the platform lock when a
 * user gesture or fullscreen transition gives the browser permission to apply
 * it. The returned state remains true when locking is unavailable so the UI
 * can fall back to a portrait-only gate.
 */
export function usePortraitOrientation(isMobile: boolean): boolean {
	const [landscape, setLandscape] = useState(() => isMobile && isLandscapeViewport());

	useEffect(() => {
		if (!isMobile || typeof window === "undefined" || typeof window.matchMedia !== "function") {
			setLandscape(false);
			return;
		}

		const mediaQuery = window.matchMedia(LANDSCAPE_QUERY);
		let lockInFlight = false;
		let retryTimer: number | null = null;

		const tryLock = () => {
			if (lockInFlight || document.visibilityState === "hidden") return;
			if (!window.screen?.orientation || typeof window.screen.orientation.lock !== "function") return;

			lockInFlight = true;
			void requestPortraitLock().finally(() => {
				lockInFlight = false;
			});
		};
		const refresh = () => {
			setLandscape(mediaQuery.matches);
			if (mediaQuery.matches) tryLock();
		};
		const retryAfterGesture = () => {
			if (retryTimer !== null) window.clearTimeout(retryTimer);
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				tryLock();
			}, 0);
		};
		const onFullscreenChange = () => {
			if (document.fullscreenElement) tryLock();
		};

		setLandscape(mediaQuery.matches);
		tryLock();
		mediaQuery.addEventListener("change", refresh);
		window.addEventListener("resize", refresh);
		document.addEventListener("fullscreenchange", onFullscreenChange);
		document.addEventListener("pointerup", retryAfterGesture, true);
		document.addEventListener("click", retryAfterGesture, true);

		return () => {
			mediaQuery.removeEventListener("change", refresh);
			window.removeEventListener("resize", refresh);
			document.removeEventListener("fullscreenchange", onFullscreenChange);
			document.removeEventListener("pointerup", retryAfterGesture, true);
			document.removeEventListener("click", retryAfterGesture, true);
			if (retryTimer !== null) window.clearTimeout(retryTimer);
		};
	}, [isMobile]);

	return isMobile && landscape;
}
