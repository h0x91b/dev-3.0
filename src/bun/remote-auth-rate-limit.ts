/**
 * Failure throttle for POST /auth/exchange.
 *
 * Only *failed* exchanges are counted, and a success clears the caller's
 * record. A device that knows the code is therefore never delayed, no matter
 * what an attacker is doing — that is what keeps this a throttle rather than a
 * lockout, and it is why several devices can still enrol back to back.
 *
 * Keyed on the socket peer address supplied by the caller, never on
 * X-Forwarded-For / CF-Connecting-IP: those are attacker-controlled on a direct
 * connection, so keying on them would hand out a fresh budget per request.
 * Behind a tunnel every request shares one peer address, so tunnel traffic
 * shares one budget — deliberate; see the decision record
 * `decisions/2026/08/28/throttle-remote-auth-exchange.md`.
 */

/** Failed exchanges allowed per key inside the window before 429s start. */
export const AUTH_FAILURE_LIMIT = 5;

/** Sliding window the failures are counted over. */
export const AUTH_FAILURE_WINDOW_MS = 30_000;

/** Hard cap on tracked keys, so a LAN attacker cannot grow the map forever. */
const MAX_TRACKED_KEYS = 1_000;

/** key → timestamps of recent failures, oldest first. */
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
	const times = failures.get(key);
	if (!times) return [];
	const cutoff = now - AUTH_FAILURE_WINDOW_MS;
	const live = times.filter((t) => t > cutoff);
	if (live.length === 0) failures.delete(key);
	else failures.set(key, live);
	return live;
}

/**
 * Seconds the caller must wait before another exchange is even evaluated, or
 * null when the attempt is allowed. Checked before the code is compared, so a
 * throttled attacker learns nothing from the response.
 */
export function authAttemptRetryAfterS(key: string, now: number = Date.now()): number | null {
	const live = recent(key, now);
	if (live.length < AUTH_FAILURE_LIMIT) return null;
	const freeAt = live[0] + AUTH_FAILURE_WINDOW_MS;
	return Math.max(1, Math.ceil((freeAt - now) / 1000));
}

export function recordAuthFailure(key: string, now: number = Date.now()): void {
	const live = recent(key, now);
	live.push(now);
	failures.set(key, live);
	if (failures.size > MAX_TRACKED_KEYS) {
		// Map iterates in insertion order: drop the least recently created keys.
		for (const oldest of failures.keys()) {
			failures.delete(oldest);
			if (failures.size <= MAX_TRACKED_KEYS) break;
		}
	}
}

/** A correct code wipes the record — a typo must not linger into the next try. */
export function clearAuthFailures(key: string): void {
	failures.delete(key);
}

export function _resetAuthRateLimitForTests(): void {
	failures.clear();
}
