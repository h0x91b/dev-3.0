/**
 * Unit tests for the /auth/exchange failure throttle. Time is injected, so no
 * test sleeps and the window boundary is exercised exactly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	AUTH_FAILURE_LIMIT,
	AUTH_FAILURE_WINDOW_MS,
	authAttemptRetryAfterS,
	recordAuthFailure,
	clearAuthFailures,
	_resetAuthRateLimitForTests,
} from "../remote-auth-rate-limit";

const T0 = 1_000_000;

beforeEach(() => {
	_resetAuthRateLimitForTests();
});

describe("auth exchange throttle", () => {
	it("allows attempts up to the limit, then blocks", () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
			expect(authAttemptRetryAfterS("1.2.3.4", T0)).toBeNull();
			recordAuthFailure("1.2.3.4", T0);
		}
		expect(authAttemptRetryAfterS("1.2.3.4", T0)).not.toBeNull();
	});

	it("reports a positive Retry-After that shrinks as the window drains", () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) recordAuthFailure("1.2.3.4", T0);
		const first = authAttemptRetryAfterS("1.2.3.4", T0)!;
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThanOrEqual(Math.ceil(AUTH_FAILURE_WINDOW_MS / 1000));
		const later = authAttemptRetryAfterS("1.2.3.4", T0 + AUTH_FAILURE_WINDOW_MS / 2)!;
		expect(later).toBeLessThan(first);
	});

	it("frees the key once the window has passed (a block is never permanent)", () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) recordAuthFailure("1.2.3.4", T0);
		expect(authAttemptRetryAfterS("1.2.3.4", T0)).not.toBeNull();
		expect(authAttemptRetryAfterS("1.2.3.4", T0 + AUTH_FAILURE_WINDOW_MS + 1)).toBeNull();
	});

	it("keeps buckets independent per key", () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) recordAuthFailure("1.2.3.4", T0);
		expect(authAttemptRetryAfterS("1.2.3.4", T0)).not.toBeNull();
		expect(authAttemptRetryAfterS("5.6.7.8", T0)).toBeNull();
	});

	it("a success wipes the record, so a typo does not linger", () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i++) recordAuthFailure("1.2.3.4", T0);
		clearAuthFailures("1.2.3.4");
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
			expect(authAttemptRetryAfterS("1.2.3.4", T0)).toBeNull();
			recordAuthFailure("1.2.3.4", T0);
		}
	});

	it("bounds a sustained attack to a low guess rate", () => {
		// The property that makes an 8-char code hopeless rather than merely slow:
		// over an hour, one key cannot exceed limit-per-window.
		const hourMs = 60 * 60 * 1000;
		let guesses = 0;
		for (let now = T0; now < T0 + hourMs; now += 100) {
			if (authAttemptRetryAfterS("1.2.3.4", now) === null) {
				guesses++;
				recordAuthFailure("1.2.3.4", now);
			}
		}
		const ceiling = AUTH_FAILURE_LIMIT * (hourMs / AUTH_FAILURE_WINDOW_MS) + AUTH_FAILURE_LIMIT;
		expect(guesses).toBeLessThanOrEqual(ceiling);
	});
});
