// Pure decision logic for the desktop RPC bridge watchdog.
//
// The Electrobun desktop transport talks to bun over a localhost WebSocket
// (see node_modules/electrobun/dist/api/browser/index.ts). That socket has no
// reconnect: after the machine sleeps it can silently drop, every `send` then
// falls through to a dead postMessage path, and each api.request.* hangs for
// the full RPC timeout with no recovery. This module decides, from periodic
// liveness pings, when to re-open the socket and when to escalate to a full
// webview reload. Kept pure so it can be unit-tested without Electrobun.

export type WatchdogAction = "none" | "reinit" | "reload";

export interface WatchdogConfig {
	/** Consecutive failed pings before any recovery is attempted. */
	failureThreshold: number;
	/** Socket re-inits allowed (since last success) before escalating to reload. */
	maxReinit: number;
	/** Minimum gap between recovery actions, to avoid thrashing. */
	recoveryCooldownMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
	failureThreshold: 2,
	maxReinit: 1,
	recoveryCooldownMs: 15_000,
};

export interface WatchdogState {
	/** A ping has succeeded at least once — the bridge was genuinely alive. */
	everAlive: boolean;
	consecutiveFailures: number;
	reinitsSinceSuccess: number;
	lastRecoveryAt: number;
}

export function createWatchdogState(): WatchdogState {
	// lastRecoveryAt starts at -Infinity so the very first recovery is never
	// blocked by the cooldown window.
	return { everAlive: false, consecutiveFailures: 0, reinitsSinceSuccess: 0, lastRecoveryAt: Number.NEGATIVE_INFINITY };
}

/**
 * Fold a single ping result into the watchdog state and return the recovery
 * action the caller should perform. Mutates `state`.
 */
export function decidePingOutcome(
	state: WatchdogState,
	ok: boolean,
	now: number,
	cfg: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
): WatchdogAction {
	if (ok) {
		state.everAlive = true;
		state.consecutiveFailures = 0;
		state.reinitsSinceSuccess = 0;
		return "none";
	}

	state.consecutiveFailures += 1;

	// Never recover a bridge that has never been alive: the initial handshake is
	// owned by Electrobun startup, and reloading before it completes would loop.
	if (!state.everAlive) return "none";
	if (state.consecutiveFailures < cfg.failureThreshold) return "none";
	if (now - state.lastRecoveryAt < cfg.recoveryCooldownMs) return "none";

	state.lastRecoveryAt = now;
	if (state.reinitsSinceSuccess < cfg.maxReinit) {
		state.reinitsSinceSuccess += 1;
		return "reinit";
	}
	return "reload";
}

/**
 * Whether a webview reload is allowed now, given the last reload timestamp.
 * Guards against reload loops: if a reload happened within `minGapMs`, deny.
 * `lastReloadAt` of NaN/undefined (never reloaded) always allows.
 */
export function shouldAllowReload(now: number, lastReloadAt: number, minGapMs: number): boolean {
	if (!Number.isFinite(lastReloadAt)) return true;
	return now - lastReloadAt >= minGapMs;
}
