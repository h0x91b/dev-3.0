import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../rpc", () => ({
	api: { request: { rendererHeartbeat: vi.fn(() => Promise.resolve()) } },
}));

import { api } from "../rpc";
import { startRendererHeartbeat } from "../renderer-heartbeat";
import { session } from "../terminal-session-stats";

const heartbeat = api.request.rendererHeartbeat as unknown as ReturnType<typeof vi.fn>;

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

let stop: (() => void) | null = null;

beforeEach(() => {
	vi.useFakeTimers();
	heartbeat.mockClear();
	heartbeat.mockImplementation(() => Promise.resolve());
	setVisibility("visible");
	session.liveTerminals = 0;
	session.frameErrorPanes = 0;
});

afterEach(() => {
	stop?.();
	stop = null;
	vi.useRealTimers();
});

describe("startRendererHeartbeat", () => {
	it("beats immediately and then on the interval", () => {
		stop = startRendererHeartbeat("win-a");
		expect(heartbeat).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(2_000);
		expect(heartbeat).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(4_000);
		expect(heartbeat).toHaveBeenCalledTimes(4);
	});

	it("carries the gap it measured and the terminals on screen", () => {
		session.liveTerminals = 3;
		session.frameErrorPanes = 1;
		stop = startRendererHeartbeat("win-a");

		vi.advanceTimersByTime(9_000);
		const calls = heartbeat.mock.calls;
		const last = calls[calls.length - 1][0];
		expect(last).toMatchObject({ clientId: "win-a", visible: true, terminals: 3, frameErrorPanes: 1 });
		expect(last.sinceLastBeatMs).toBeGreaterThan(0);
	});

	it("beats once more on the way to hidden, so silence reads as throttling", () => {
		stop = startRendererHeartbeat("win-a");
		heartbeat.mockClear();

		setVisibility("hidden");
		document.dispatchEvent(new Event("visibilitychange"));

		expect(heartbeat).toHaveBeenCalledTimes(1);
		expect(heartbeat.mock.calls[0][0]).toMatchObject({ visible: false, hiddenSinceLastBeat: true });
	});

	it("stops marking gaps as hidden once the window is back on screen", () => {
		stop = startRendererHeartbeat("win-a");
		setVisibility("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		heartbeat.mockClear();

		// First beat back covers the hidden stretch; the next one is clean again.
		vi.advanceTimersByTime(2_000);
		expect(heartbeat.mock.calls[0][0]).toMatchObject({ visible: true, hiddenSinceLastBeat: false });
	});

	it("survives a backend that rejects — diagnostics never break the app", () => {
		heartbeat.mockImplementation(() => Promise.reject(new Error("rpc down")));
		stop = startRendererHeartbeat("win-a");
		expect(() => vi.advanceTimersByTime(6_000)).not.toThrow();
	});

	it("stops beating once disposed", () => {
		stop = startRendererHeartbeat("win-a");
		stop();
		stop = null;
		heartbeat.mockClear();

		vi.advanceTimersByTime(10_000);
		setVisibility("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(heartbeat).not.toHaveBeenCalled();
	});
});
