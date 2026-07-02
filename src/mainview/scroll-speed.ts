// ── Terminal scroll-speed module ──
// Controls how fast the mouse wheel scrolls the terminal. The wheel handler in
// TerminalView accumulates raw pixel `deltaY` and reports one tmux scroll-wheel
// event per `SCROLL_THRESHOLD` px accumulated. A smaller threshold = more wheel
// events per pixel = faster scroll. We expose a user-facing *speed multiplier*
// (higher = faster) and derive the threshold as BASE / speed.
//
// This is a per-device rendering preference (same species as zoom), so it is
// persisted in localStorage and applied live via a change event — no backend RPC.

const SCROLL_SPEED_KEY = "dev3-terminal-scroll-speed";
export const DEFAULT_SCROLL_SPEED = 2.0;
export const MIN_SCROLL_SPEED = 0.5;
export const MAX_SCROLL_SPEED = 5.0;
export const SCROLL_SPEED_STEP = 0.25;
export const SCROLL_SPEED_CHANGED_EVENT = "terminal-scroll-speed-changed" as const;

// Baseline pixel threshold at speed 1.0 (the historical fixed SCROLL_THRESHOLD).
const BASE_SCROLL_THRESHOLD = 50;

/** In-memory cache — avoids localStorage reads on every wheel event. */
let currentScrollSpeed = DEFAULT_SCROLL_SPEED;

function clampSpeed(level: number): number {
	const bounded = Math.max(MIN_SCROLL_SPEED, Math.min(MAX_SCROLL_SPEED, level));
	// Round to 2 decimals so 0.25 steps stay exact.
	return Math.round(bounded * 100) / 100;
}

export function getScrollSpeed(): number {
	return currentScrollSpeed;
}

/**
 * Pixel threshold to accumulate before reporting one tmux scroll-wheel event.
 * Read this inside the wheel handler so speed changes apply live.
 */
export function getScrollThreshold(): number {
	return BASE_SCROLL_THRESHOLD / currentScrollSpeed;
}

export function applyScrollSpeed(level: number) {
	const clamped = clampSpeed(level);
	currentScrollSpeed = clamped;
	try {
		localStorage.setItem(SCROLL_SPEED_KEY, String(clamped));
	} catch {
		// localStorage unavailable — keep the in-memory value, apply still works.
	}
	window.dispatchEvent(
		new CustomEvent(SCROLL_SPEED_CHANGED_EVENT, { detail: clamped }),
	);
}

/** Call once before React mounts to load the saved speed into the cache. */
export function bootstrapScrollSpeed() {
	let saved = DEFAULT_SCROLL_SPEED;
	try {
		const parsed = parseFloat(localStorage.getItem(SCROLL_SPEED_KEY) ?? "");
		if (Number.isFinite(parsed)) saved = parsed;
	} catch {
		// localStorage unavailable — fall back to default.
	}
	currentScrollSpeed = clampSpeed(saved);
}
