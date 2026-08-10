/**
 * Renderer half of the flag loop (seq 1470). What must hold: every renderer pushes
 * what it evaluated (a browser that stayed silent left the host on shipped defaults
 * and made Refresh a dead button), only the desktop one polls, the identity reported
 * to the host is the one PostHog evaluates against, and a manual refresh reports
 * whether an answer actually arrived.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { ph, rpc, env } = vi.hoisted(() => ({
	ph: {
		flags: {} as Record<string, boolean | undefined>,
		listeners: [] as Array<() => void>,
		distinctId: "renderer-id",
		reloadCalls: 0,
	},
	rpc: { pushed: [] as Array<Record<string, boolean>> },
	env: { isElectrobun: true },
}));

vi.mock("../posthog", () => ({
	default: {
		getFeatureFlag: (key: string) => ph.flags[key],
		get_distinct_id: () => ph.distinctId,
		onFeatureFlags: (cb: () => void) => {
			ph.listeners.push(cb);
			return () => {
				ph.listeners = ph.listeners.filter((l) => l !== cb);
			};
		},
		reloadFeatureFlags: () => {
			ph.reloadCalls += 1;
		},
	},
}));

vi.mock("../rpc", () => ({
	api: {
		request: {
			setFeatureFlags: vi.fn(({ flags }: { flags: Record<string, boolean> }) => {
				rpc.pushed.push(flags);
				return Promise.resolve();
			}),
			resolveAnalyticsDistinctId: vi.fn(() => Promise.resolve({ distinctId: "host-id" })),
		},
	},
	get isElectrobun() {
		return env.isElectrobun;
	},
}));

import { api } from "../rpc";
import { evaluatingDistinctId, initFeatureFlags, refreshFeatureFlagsNow } from "../feature-flags";

beforeEach(() => {
	ph.flags = {};
	ph.listeners = [];
	ph.distinctId = "renderer-id";
	ph.reloadCalls = 0;
	rpc.pushed = [];
	env.isElectrobun = true;
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("renderer feature flags", () => {
	it("reports the id PostHog evaluates as, claiming identity for the desktop window", () => {
		initFeatureFlags();
		expect(api.request.resolveAnalyticsDistinctId).toHaveBeenCalledWith({
			seed: "renderer-id",
			authoritative: true,
		});
		expect(evaluatingDistinctId()).toBe("renderer-id");
	});

	it("reports without claiming identity from a browser, which may have an id of its own", () => {
		env.isElectrobun = false;
		initFeatureFlags();
		expect(api.request.resolveAnalyticsDistinctId).toHaveBeenCalledWith({
			seed: "renderer-id",
			authoritative: false,
		});
	});

	it("pushes evaluated values to the host when PostHog answers", () => {
		ph.flags["remote-terminal-latency"] = true;
		initFeatureFlags();

		ph.listeners.forEach((l) => l());

		expect(rpc.pushed).toEqual([{ "remote-terminal-latency": true }]);
	});

	it("pushes from a browser renderer too, so its Debug window is not a liar", () => {
		env.isElectrobun = false;
		initFeatureFlags();

		ph.listeners.forEach((l) => l());

		expect(rpc.pushed).toHaveLength(1);
	});

	it("polls only in the desktop renderer — one poller per install, not per browser", () => {
		vi.useFakeTimers();
		env.isElectrobun = false;
		initFeatureFlags();
		vi.advanceTimersByTime(20 * 60 * 1000);
		expect(ph.reloadCalls).toBe(0);

		env.isElectrobun = true;
		initFeatureFlags();
		vi.advanceTimersByTime(20 * 60 * 1000);
		expect(ph.reloadCalls).toBeGreaterThan(0);
	});

	it("resolves true once a manual refresh has been answered and pushed", async () => {
		ph.flags["remote-terminal-latency"] = false;
		const pending = refreshFeatureFlagsNow();
		expect(ph.reloadCalls).toBe(1);

		ph.flags["remote-terminal-latency"] = true;
		ph.listeners.forEach((l) => l());

		await expect(pending).resolves.toBe(true);
		expect(rpc.pushed).toEqual([{ "remote-terminal-latency": true }]);
	});

	it("resolves false when PostHog never answers, instead of looking successful", async () => {
		vi.useFakeTimers();
		const pending = refreshFeatureFlagsNow();
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(pending).resolves.toBe(false);
	});

	it("drops its one-shot listener, so a later answer is not counted twice", async () => {
		const pending = refreshFeatureFlagsNow();
		ph.listeners.forEach((l) => l());
		await pending;
		expect(ph.listeners).toHaveLength(0);
	});
});
