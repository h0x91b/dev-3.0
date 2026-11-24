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
 *
 * Desktop browsers in remote mode get the same first-click engage while the
 * `remoteAutoFullscreen` setting is on — but only where Keyboard Lock exists
 * (Chromium), because fullscreen is what lets the page own ⌘W / Ctrl+W there.
 * Elsewhere it would hide the browser chrome for nothing.
 */

let autoEngageSpent = false;
let mobileEngage = false;
let desktopEngage = false;
let desktopEngageEnabled = true;
let armFirstTap: (() => void) | null = null;
let initialized = false;
const listeners = new Set<() => void>();
// Kept for test teardown — production never uninstalls them.
let installedFullscreenChange: (() => void) | null = null;
let installedFirstTap: ((e: Event) => void) | null = null;

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

function canAutoEngage(): boolean {
	return isFullscreenSupported() && (mobileEngage || (desktopEngage && desktopEngageEnabled));
}

function disarmFirstTap(): void {
	if (!installedFirstTap) return;
	document.removeEventListener("click", installedFirstTap, true);
	installedFirstTap = null;
}

/** Clicks inside this marker never auto-engage — e.g. the toggle that turns it off. */
export const NO_AUTO_FULLSCREEN_ATTR = "data-no-auto-fullscreen";

/**
 * Follow the `remoteAutoFullscreen` setting (default on). Only matters when
 * bootstrap armed the desktop engage; mobile always engages.
 */
export function setDesktopAutoFullscreen(enabled: boolean): void {
	desktopEngageEnabled = enabled;
	if (typeof document === "undefined") return;
	if (canAutoEngage()) armFirstTap?.();
	else if (!mobileEngage) disarmFirstTap();
}

/**
 * Install the fullscreen listeners. Call once at bootstrap (main.tsx).
 * `mobile: true` arms the one-shot first-tap auto-engage; `desktop: true` arms
 * it too while {@link setDesktopAutoFullscreen} allows.
 */
export function initAutoFullscreen(opts: { mobile: boolean; desktop?: boolean }): void {
	if (initialized || typeof document === "undefined") return;
	initialized = true;
	mobileEngage = opts.mobile;
	desktopEngage = !opts.mobile && opts.desktop === true;

	armFirstTap = () => {
		if (!canAutoEngage() || autoEngageSpent || installedFirstTap) return;
		const onFirstTap = (e: Event) => {
			if ((e.target as Element | null)?.closest?.(`[${NO_AUTO_FULLSCREEN_ATTR}]`)) return;
			document.removeEventListener("click", onFirstTap, true);
			installedFirstTap = null;
			autoEngageSpent = true;
			// A denied request fires no fullscreenchange, so re-arm here or the engage is dead for good.
			void enterFullscreen().then(() => {
				if (document.fullscreenElement) return;
				autoEngageSpent = false;
				armFirstTap?.();
			});
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
			armFirstTap?.();
		}
	};
	document.addEventListener("fullscreenchange", onFullscreenChange);
	installedFullscreenChange = onFullscreenChange;

	armFirstTap?.();
}

/** Reset module state and uninstall document listeners. Tests only. */
export function __resetFullscreenForTests(): void {
	autoEngageSpent = false;
	initialized = false;
	mobileEngage = false;
	desktopEngage = false;
	desktopEngageEnabled = true;
	armFirstTap = null;
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
