import { describe, it, expect } from "vitest";
import {
	createWatchdogState,
	decidePingOutcome,
	shouldAllowReload,
	DEFAULT_WATCHDOG_CONFIG,
	type WatchdogConfig,
} from "../rpc-watchdog";

const cfg: WatchdogConfig = { failureThreshold: 2, maxReinit: 1, recoveryCooldownMs: 15_000 };

describe("decidePingOutcome", () => {
	it("does nothing while pings succeed and marks bridge alive", () => {
		const s = createWatchdogState();
		expect(decidePingOutcome(s, true, 0, cfg)).toBe("none");
		expect(s.everAlive).toBe(true);
		expect(s.consecutiveFailures).toBe(0);
	});

	it("never recovers a bridge that was never alive", () => {
		const s = createWatchdogState();
		expect(decidePingOutcome(s, false, 0, cfg)).toBe("none");
		expect(decidePingOutcome(s, false, 1000, cfg)).toBe("none");
		expect(decidePingOutcome(s, false, 2000, cfg)).toBe("none");
		expect(s.everAlive).toBe(false);
	});

	it("waits for the failure threshold before acting", () => {
		const s = createWatchdogState();
		decidePingOutcome(s, true, 0, cfg); // alive
		expect(decidePingOutcome(s, false, 100, cfg)).toBe("none"); // 1 failure
		expect(decidePingOutcome(s, false, 200, cfg)).toBe("reinit"); // 2nd → recover
	});

	it("escalates from reinit to reload after maxReinit, respecting cooldown", () => {
		const s = createWatchdogState();
		decidePingOutcome(s, true, 0, cfg); // alive
		decidePingOutcome(s, false, 100, cfg); // failure 1
		expect(decidePingOutcome(s, false, 200, cfg)).toBe("reinit"); // recovery #1
		// Within cooldown: no further action even though still failing.
		expect(decidePingOutcome(s, false, 5_000, cfg)).toBe("none");
		// After cooldown elapses, reinit budget exhausted → reload.
		expect(decidePingOutcome(s, false, 20_000, cfg)).toBe("reload");
	});

	it("resets recovery budget after a successful ping", () => {
		const s = createWatchdogState();
		decidePingOutcome(s, true, 0, cfg);
		decidePingOutcome(s, false, 100, cfg);
		expect(decidePingOutcome(s, false, 200, cfg)).toBe("reinit");
		// Bridge recovers.
		expect(decidePingOutcome(s, true, 300, cfg)).toBe("none");
		expect(s.reinitsSinceSuccess).toBe(0);
		expect(s.consecutiveFailures).toBe(0);
		// Next failure cycle starts fresh with reinit again, not reload.
		decidePingOutcome(s, false, 20_000, cfg);
		expect(decidePingOutcome(s, false, 20_100, cfg)).toBe("reinit");
	});

	it("exposes sane defaults", () => {
		expect(DEFAULT_WATCHDOG_CONFIG.failureThreshold).toBeGreaterThanOrEqual(1);
		expect(DEFAULT_WATCHDOG_CONFIG.maxReinit).toBeGreaterThanOrEqual(1);
		expect(DEFAULT_WATCHDOG_CONFIG.recoveryCooldownMs).toBeGreaterThan(0);
	});
});

describe("shouldAllowReload", () => {
	it("allows the first reload (never reloaded before)", () => {
		expect(shouldAllowReload(1000, NaN, 30_000)).toBe(true);
		expect(shouldAllowReload(1000, Number.NEGATIVE_INFINITY, 30_000)).toBe(true);
	});

	it("denies a reload within the minimum gap", () => {
		expect(shouldAllowReload(10_000, 0, 30_000)).toBe(false);
		expect(shouldAllowReload(29_999, 0, 30_000)).toBe(false);
	});

	it("allows a reload once the gap has elapsed", () => {
		expect(shouldAllowReload(30_000, 0, 30_000)).toBe(true);
		expect(shouldAllowReload(60_000, 0, 30_000)).toBe(true);
	});
});
