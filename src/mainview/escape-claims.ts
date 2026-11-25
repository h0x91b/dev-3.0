/**
 * Who wants the Escape key right now: every open layer that closes on Esc
 * (`useEscapeKey`, `registerOverlayLayer`). Keyboard Lock reads it so a fullscreen
 * browser hands Esc to the open dialog instead of leaving fullscreen with it.
 */

let claims = 0;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* a broken subscriber must not break the rest */
		}
	}
}

/** Claim Escape for an open layer. Returns the release function (idempotent). */
export function claimEscape(): () => void {
	claims += 1;
	notify();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		claims -= 1;
		notify();
	};
}

/** Whether any open layer closes on Escape. */
export function hasEscapeClaims(): boolean {
	return claims > 0;
}

export function subscribeEscapeClaims(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Reset module state. Tests only. */
export function __resetEscapeClaimsForTests(): void {
	claims = 0;
	listeners.clear();
}
