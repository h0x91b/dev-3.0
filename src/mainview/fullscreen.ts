/**
 * Mobile fullscreen management for remote/browser mode.
 *
 * Browser chrome (address bar + system bars) wastes a large share of a phone
 * screen, so on mobile the UI enters fullscreen on the FIRST tap after page
 * load (requestFullscreen needs a user gesture). The listener is one-shot
 * while fullscreen is active, then re-arms after an exit so the next user tap
 * restores fullscreen. A deliberate Fullscreen toggle lives in the mobile
 * menu action sheet (GlobalHeader).
 *
 * Explicitly NOT a PWA: the serving origin (tunnel hostname / LAN port) is
 * unstable per launch, so an installed PWA would rot immediately.
 *
 * iPhone Safari has NO Fullscreen API for arbitrary elements (Apple shipped
 * it flag-gated in 17.2 and disabled it again in 17.4) — only <video> can go
 * fullscreen there. On iPhone `isFullscreenSupported()` is false, so both the
 * auto-engage and the menu toggle are absent. Platform limitation, not a bug —
 * see decision 134.
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

	const canAutoEngage = opts.mobile && isFullscreenSupported();
	const armFirstTap = () => {
		if (!canAutoEngage || autoEngageSpent || installedFirstTap) return;
		const onFirstTap = () => {
			document.removeEventListener("click", onFirstTap, true);
			installedFirstTap = null;
			autoEngageSpent = true;
			void enterFullscreen();
		};
		document.addEventListener("click", onFirstTap, true);
		installedFirstTap = onFirstTap;
	};

	const onFullscreenChange = () => {
		notifyListeners();
		// A browser exit needs a fresh user gesture before requestFullscreen can
		// succeed, so restore the one-shot listener instead of re-entering here.
		if (!document.fullscreenElement) {
			autoEngageSpent = false;
			armFirstTap();
		}
	};
	document.addEventListener("fullscreenchange", onFullscreenChange);
	installedFullscreenChange = onFullscreenChange;

	armFirstTap();
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
