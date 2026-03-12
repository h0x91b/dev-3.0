import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../rpc", () => ({
	api: {
		request: {
			logRendererError: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

// Stub localStorage
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => { store[key] = value; },
		removeItem: (key: string) => { delete store[key]; },
	},
	writable: true,
});

// Stub navigator
Object.defineProperty(globalThis, "navigator", {
	value: { userAgent: "test", language: "en", platform: "test" },
	writable: true,
});

// Stub screen
Object.defineProperty(globalThis, "screen", {
	value: { width: 1920, height: 1080 },
	writable: true,
});

// Stub crypto
Object.defineProperty(globalThis, "crypto", {
	value: { randomUUID: () => "test-uuid-1234" },
	writable: true,
});

// Stub fetch
globalThis.fetch = vi.fn().mockResolvedValue(undefined) as unknown as typeof fetch;

import { initAnalytics, destroyAnalytics } from "../analytics";

describe("initAnalytics", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Clear localStorage entries
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
	});

	afterEach(() => {
		destroyAnalytics();
		vi.useRealTimers();
	});

	it("calling initAnalytics twice does not stack duplicate heartbeat intervals", () => {
		const clearSpy = vi.spyOn(globalThis, "clearInterval");

		initAnalytics("1.0.0");
		initAnalytics("1.0.0"); // second call should clear the first interval

		// clearInterval should have been called once (to clear the first interval)
		expect(clearSpy).toHaveBeenCalledTimes(1);

		// Advance past one heartbeat period — only one heartbeat event should fire
		const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
		vi.advanceTimersByTime(10 * 60 * 1000 + 100);
		const heartbeatCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length - fetchCalls;
		// Exactly 1 heartbeat (not 2 from stacked intervals)
		expect(heartbeatCalls).toBe(1);

		clearSpy.mockRestore();
	});

	it("destroyAnalytics stops heartbeat interval", () => {
		initAnalytics("1.0.0");
		destroyAnalytics();

		const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
		vi.advanceTimersByTime(10 * 60 * 1000 + 100);
		const heartbeatCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length - fetchCalls;
		expect(heartbeatCalls).toBe(0);
	});
});
