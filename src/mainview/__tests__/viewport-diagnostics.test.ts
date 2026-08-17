import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../rpc", () => ({
	api: { request: { logRendererDiagnostic: vi.fn(() => Promise.resolve()) } },
}));

import { api } from "../rpc";
import { startViewportDiagnostics } from "../viewport-diagnostics";

const logDiagnostic = api.request.logRendererDiagnostic as unknown as ReturnType<typeof vi.fn>;

function setViewport(width: number, height: number, dpr: number) {
	Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
	Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
	Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
}

let stop: (() => void) | null = null;

beforeEach(() => {
	vi.useFakeTimers();
	logDiagnostic.mockClear();
	setViewport(1440, 900, 2);
});

afterEach(() => {
	stop?.();
	stop = null;
	vi.useRealTimers();
});

describe("startViewportDiagnostics", () => {
	it("reports the viewport once at startup", () => {
		stop = startViewportDiagnostics();

		expect(logDiagnostic).toHaveBeenCalledTimes(1);
		expect(logDiagnostic.mock.calls[0][0]).toMatchObject({
			tag: "viewport",
			extra: { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2 },
		});
	});

	it("reports a resolution change, including a devicePixelRatio flip", () => {
		stop = startViewportDiagnostics();
		logDiagnostic.mockClear();

		setViewport(1280, 800, 1);
		window.dispatchEvent(new Event("resize"));
		vi.advanceTimersByTime(600);

		expect(logDiagnostic).toHaveBeenCalledTimes(1);
		expect(logDiagnostic.mock.calls[0][0].extra).toMatchObject({ innerWidth: 1280, devicePixelRatio: 1 });
	});

	it("writes nothing when a resize lands on the same geometry", () => {
		stop = startViewportDiagnostics();
		logDiagnostic.mockClear();

		window.dispatchEvent(new Event("resize"));
		vi.advanceTimersByTime(600);

		expect(logDiagnostic).not.toHaveBeenCalled();
	});

	it("collapses a drag into one line instead of one per event", () => {
		stop = startViewportDiagnostics();
		logDiagnostic.mockClear();

		for (const width of [1400, 1360, 1320, 1300]) {
			setViewport(width, 900, 2);
			window.dispatchEvent(new Event("resize"));
			vi.advanceTimersByTime(50);
		}
		vi.advanceTimersByTime(600);

		expect(logDiagnostic).toHaveBeenCalledTimes(1);
		expect(logDiagnostic.mock.calls[0][0].extra).toMatchObject({ innerWidth: 1300 });
	});

	it("stops reporting after it is stopped", () => {
		const stopFn = startViewportDiagnostics();
		stopFn();
		logDiagnostic.mockClear();

		setViewport(1000, 700, 1);
		window.dispatchEvent(new Event("resize"));
		vi.advanceTimersByTime(600);

		expect(logDiagnostic).not.toHaveBeenCalled();
	});

	it("survives a dead RPC bridge without throwing", () => {
		logDiagnostic.mockImplementation(() => {
			throw new Error("bridge is dead");
		});

		expect(() => {
			stop = startViewportDiagnostics();
		}).not.toThrow();
	});
});
