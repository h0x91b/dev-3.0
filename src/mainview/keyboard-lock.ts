/**
 * Keyboard Lock for browser remote mode — the only way out of the browser's own
 * shortcut layer.
 *
 * In a plain tab the browser keeps ⌘W/⌘T/⌘N/⌘1–9/zoom for itself and a page
 * cannot cancel them, so those shortcuts are declared `desktopOnly` and simply
 * do not fire in remote. `navigator.keyboard.lock()` hands them to the page —
 * but only while the document is fullscreen, and only in Chromium (Safari and
 * Firefox do not implement it). So this is an upgrade, never a requirement:
 * everything works without it, and more works with it.
 *
 * `Escape` is deliberately NOT locked. Locking it makes leaving fullscreen a
 * press-and-hold gesture, which reads as a frozen app to anyone who does not
 * know the trick — and Escape is our own "close this layer" key anyway.
 */

import { subscribeFullscreen, isFullscreenActive } from "./fullscreen";
import { isRemote } from "./utils/platform";

interface KeyboardLockApi {
	lock?: (codes?: string[]) => Promise<void>;
	unlock?: () => void;
}

function keyboardApi(): KeyboardLockApi | null {
	if (typeof navigator === "undefined") return null;
	const kb = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
	return kb && typeof kb.lock === "function" ? kb : null;
}

/** Whether this browser can hand its own combos to the page at all. */
export function isKeyboardLockSupported(): boolean {
	return keyboardApi() !== null;
}

/**
 * The keys worth taking back: the ones a browser refuses to give up. Requested
 * explicitly rather than as "everything", so the browser keeps the shortcuts a
 * user still needs (devtools, print) and `Escape` keeps leaving fullscreen with
 * a single press. Deliberately NOT derived from the shortcut registry — that
 * would make `keymap.ts` and this module import each other.
 */
const LOCKED_CODES = [
	"KeyW", "KeyT", "KeyN", "KeyL", "KeyR", "KeyQ", "KeyD", "KeyP", "KeyF",
	"Minus", "Equal", "BracketLeft", "BracketRight", "Backquote", "Tab",
	"Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
	"F5", "F11", "F12",
];

let locked = false;
const listeners = new Set<() => void>();
let installed = false;

/** True while the browser's own combos belong to the app. */
export function isKeyboardLocked(): boolean {
	return locked;
}

/** Subscribe to lock state changes (`useSyncExternalStore`-compatible). */
export function subscribeKeyboardLock(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function setLocked(next: boolean): void {
	if (locked === next) return;
	locked = next;
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* a broken subscriber must not break the rest */
		}
	}
}

async function syncToFullscreen(): Promise<void> {
	const kb = keyboardApi();
	if (!kb) return;
	if (isFullscreenActive()) {
		try {
			await kb.lock?.(LOCKED_CODES);
			setLocked(true);
		} catch {
			// Denied or unsupported for this document — stay on the normal keymap.
			setLocked(false);
		}
		return;
	}
	try {
		kb.unlock?.();
	} catch {
		/* nothing held the lock */
	}
	setLocked(false);
}

/**
 * Follow fullscreen with the keyboard lock. Call once at bootstrap; a no-op in
 * the desktop shell, where the app already owns every combo.
 */
export function initKeyboardLock(): void {
	if (installed || !isRemote() || !isKeyboardLockSupported()) return;
	installed = true;
	subscribeFullscreen(() => void syncToFullscreen());
	void syncToFullscreen();
}

/** Reset module state. Tests only. */
export function __resetKeyboardLockForTests(): void {
	installed = false;
	locked = false;
	listeners.clear();
}
