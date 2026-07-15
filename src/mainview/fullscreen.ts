/**
 * Mobile fullscreen management for remote/browser mode.
 *
 * Browser chrome (address bar + system bars) wastes a large share of a phone
 * screen, so on mobile the UI enters fullscreen on the FIRST tap after page
 * load (requestFullscreen needs a user gesture). One-shot per load: once
 * engaged — or once the user exits by any means (system gesture, Esc, the
 * menu toggle) — auto-engage stays off until the next page load, so the app
 * never fights the user's gestures. A deliberate Fullscreen toggle lives in
 * the mobile menu action sheet (GlobalHeader).
 *
 * Explicitly NOT a PWA: the serving origin (tunnel hostname / LAN port) is
 * unstable per launch, so an installed PWA would rot immediately.
 *
 * iPhone Safari has NO Fullscreen API for arbitrary elements (Apple shipped
 * it flag-gated in 17.2 and disabled it again in 17.4) — only <video> can go
 * fullscreen there. On iPhone `isFullscreenSupported()` is false, so both the
 * auto-engage and the menu toggle are absent. Platform limitation, not a bug.
 */

let autoEngageSpent = false;
let initialized = false;
const listeners = new Set<() => void>();
// Kept for test teardown — production never uninstalls them.
let installedFullscreenChange: (() => void) | null = null;
let installedFirstTap: (() => void) | null = null;

function notifyListeners(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* a broken subscriber must not break the rest */
		}
	}
}

/** Whether the document is currently fullscreen. */
export function isFullscreenActive(): boolean {
	return typeof document !== "undefined" && !!document.fullscreenElement;
}

/** Whether element fullscreen exists at all (false on iPhone Safari). */
export function isFullscreenSupported(): boolean {
	return (
		typeof document !== "undefined" &&
		typeof document.documentElement.requestFullscreen === "function"
	);
}

/** Subscribe to fullscreen state changes (useSyncExternalStore-compatible). */
export function subscribeFullscreen(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export async function enterFullscreen(): Promise<void> {
	try {
		await document.documentElement.requestFullscreen?.();
	} catch {
		/* rejected (no gesture) or unsupported — the UI simply stays windowed */
	}
}

export async function exitFullscreen(): Promise<void> {
	try {
		if (document.fullscreenElement) await document.exitFullscreen();
	} catch {
		/* already left */
	}
}

export async function toggleFullscreen(): Promise<void> {
	if (isFullscreenActive()) {
		await exitFullscreen();
	} else {
		await enterFullscreen();
	}
}

/**
 * Install the fullscreen listeners. Call once at bootstrap (main.tsx).
 * `mobile: true` additionally arms the one-shot first-tap auto-engage.
 */
export function initAutoFullscreen(opts: { mobile: boolean }): void {
	if (initialized || typeof document === "undefined") return;
	initialized = true;

	const onFullscreenChange = () => {
		notifyListeners();
		// Any exit — system gesture, Esc, or the menu toggle — is the user's
		// call: never auto re-engage until the next page load.
		if (!document.fullscreenElement) autoEngageSpent = true;
	};
	document.addEventListener("fullscreenchange", onFullscreenChange);
	installedFullscreenChange = onFullscreenChange;

	if (!opts.mobile || !isFullscreenSupported()) return;

	const onFirstTap = () => {
		document.removeEventListener("click", onFirstTap, true);
		installedFirstTap = null;
		if (autoEngageSpent) return;
		autoEngageSpent = true;
		void enterFullscreen();
	};
	document.addEventListener("click", onFirstTap, true);
	installedFirstTap = onFirstTap;
}

/** Reset module state and uninstall document listeners. Tests only. */
export function __resetFullscreenForTests(): void {
	autoEngageSpent = false;
	initialized = false;
	listeners.clear();
	if (installedFullscreenChange) {
		document.removeEventListener("fullscreenchange", installedFullscreenChange);
		installedFullscreenChange = null;
	}
	if (installedFirstTap) {
		document.removeEventListener("click", installedFirstTap, true);
		installedFirstTap = null;
	}
}
