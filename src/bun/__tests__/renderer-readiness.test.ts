import { describe, expect, it, vi } from "vitest";
import {
	RENDERER_READY_TIMEOUT_MS,
	RENDERER_UNAVAILABLE_MARKER,
	buildRendererUnavailableDiagnostic,
	createRendererReadinessWatchdog,
	resolveRendererReadyTimeoutMs,
} from "../renderer-readiness";
import { hardExit } from "../hard-exit";
import { CLI_EXIT_CODE_RENDERER_UNAVAILABLE } from "../../shared/cli-exit-codes";

/** Deterministic stand-in for setTimeout: nothing fires until `run()`. */
function fakeTimers() {
	const pending = new Map<number, () => void>();
	let nextId = 1;
	let clock = 0;
	return {
		setTimer: (fn: () => void) => {
			const id = nextId++;
			pending.set(id, fn);
			return id;
		},
		clearTimer: (handle: unknown) => {
			pending.delete(handle as number);
		},
		now: () => clock,
		advance: (ms: number) => {
			clock += ms;
		},
		fire: () => {
			for (const fn of [...pending.values()]) fn();
		},
		pendingCount: () => pending.size,
	};
}

function watchdogWith(timeoutMs: number | null) {
	const timers = fakeTimers();
	const onTimeout = vi.fn();
	const onReady = vi.fn();
	const onArmed = vi.fn();
	const watchdog = createRendererReadinessWatchdog({
		timeoutMs,
		onTimeout,
		onReady,
		onArmed,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		now: timers.now,
	});
	return { watchdog, timers, onTimeout, onReady, onArmed };
}

describe("resolveRendererReadyTimeoutMs", () => {
	it("watches win32 by default and leaves macOS/Linux untouched", () => {
		expect(resolveRendererReadyTimeoutMs({}, "win32")).toBe(RENDERER_READY_TIMEOUT_MS);
		expect(resolveRendererReadyTimeoutMs({}, "darwin")).toBeNull();
		expect(resolveRendererReadyTimeoutMs({}, "linux")).toBeNull();
	});

	it("honours an explicit budget on every platform", () => {
		expect(resolveRendererReadyTimeoutMs({ DEV3_RENDERER_READY_TIMEOUT_MS: "2500" }, "darwin")).toBe(2500);
		expect(resolveRendererReadyTimeoutMs({ DEV3_RENDERER_READY_TIMEOUT_MS: " 900 " }, "win32")).toBe(900);
	});

	it("treats 0 as 'disable the watchdog'", () => {
		expect(resolveRendererReadyTimeoutMs({ DEV3_RENDERER_READY_TIMEOUT_MS: "0" }, "win32")).toBeNull();
	});

	it("falls back to the platform default rather than disabling on garbage", () => {
		for (const raw of ["", "  ", "abc", "-5", "NaN", "Infinity"]) {
			expect(resolveRendererReadyTimeoutMs({ DEV3_RENDERER_READY_TIMEOUT_MS: raw }, "win32")).toBe(
				RENDERER_READY_TIMEOUT_MS,
			);
		}
	});
});

describe("renderer readiness watchdog", () => {
	it("fires the failure path exactly once when no renderer reports", () => {
		const { watchdog, timers, onTimeout, onArmed } = watchdogWith(1_000);
		watchdog.arm();

		expect(onArmed).toHaveBeenCalledWith(1_000);
		expect(watchdog.state()).toBe("armed");

		timers.fire();

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onTimeout).toHaveBeenCalledWith(1_000);
		expect(watchdog.state()).toBe("failed");

		// A late dom-ready after the failure must not resurrect the launch.
		expect(watchdog.markReady("dom-ready")).toBe(false);
		expect(watchdog.state()).toBe("failed");
	});

	it("disarms on the first dom-ready and reports the elapsed time", () => {
		const { watchdog, timers, onTimeout, onReady } = watchdogWith(1_000);
		watchdog.arm();
		timers.advance(366);

		expect(watchdog.markReady("dom-ready")).toBe(true);
		expect(watchdog.state()).toBe("ready");
		expect(onReady).toHaveBeenCalledWith("dom-ready", 366);
		expect(timers.pendingCount()).toBe(0);

		// Nothing is left to fire, and a second window is not a second chance.
		timers.fire();
		expect(onTimeout).not.toHaveBeenCalled();
		expect(watchdog.markReady("dom-ready")).toBe(false);
	});

	it("arms only once, so extra windows never restart the budget", () => {
		const { watchdog, timers, onArmed } = watchdogWith(1_000);
		watchdog.arm();
		watchdog.arm();
		expect(onArmed).toHaveBeenCalledTimes(1);
		expect(timers.pendingCount()).toBe(1);
	});

	it("never arms a timer when disabled, but still gates first-ready work", () => {
		const { watchdog, timers, onTimeout, onReady } = watchdogWith(null);
		expect(watchdog.state()).toBe("disabled");

		watchdog.arm();
		expect(timers.pendingCount()).toBe(0);
		timers.fire();
		expect(onTimeout).not.toHaveBeenCalled();

		expect(watchdog.markReady("dom-ready")).toBe(true);
		expect(watchdog.markReady("dom-ready")).toBe(false);
		expect(onReady).toHaveBeenCalledTimes(1);
	});
});

describe("renderer-unavailable diagnostic", () => {
	it("carries the grep marker, the budget and the documented exit code", () => {
		const text = buildRendererUnavailableDiagnostic(45_000, "win32");
		expect(text).toContain(RENDERER_UNAVAILABLE_MARKER);
		expect(text).toContain("45000ms");
		expect(text).toContain(`code ${CLI_EXIT_CODE_RENDERER_UNAVAILABLE}`);
	});

	it("names the two real Windows causes with runnable next steps", () => {
		const text = buildRendererUnavailableDiagnostic(45_000, "win32");
		expect(text).toContain("0x80070578");
		expect(text).toContain("winget install --id Microsoft.EdgeWebView2Runtime -e");
		expect(text).toContain("dev3 remote");
	});

	it("stays useful off Windows without inventing Windows advice", () => {
		const text = buildRendererUnavailableDiagnostic(1_000, "darwin");
		expect(text).toContain(RENDERER_UNAVAILABLE_MARKER);
		expect(text).not.toContain("0x80070578");
		expect(text).toContain("dev3 remote");
	});
});

describe("hardExit", () => {
	function fakeProc(platform: NodeJS.Platform = "win32", withReallyExit = true) {
		return {
			platform,
			exit: vi.fn() as never,
			...(withReallyExit ? { reallyExit: vi.fn() } : {}),
		};
	}

	it("exits through the OS primitive first — electrobun survives reallyExit", async () => {
		const osExit = vi.fn();
		const proc = fakeProc();
		await hardExit(8, { proc, osExit });
		expect(osExit).toHaveBeenCalledWith(8, "win32");
	});

	it("falls back to reallyExit and then process.exit when the OS exit fails", async () => {
		const osExit = vi.fn(() => { throw new Error("dlopen failed"); });
		const proc = fakeProc();
		await hardExit(8, { proc, osExit });
		expect(proc.reallyExit).toHaveBeenCalledWith(8);
		expect(proc.exit).toHaveBeenCalledWith(8);
	});

	it("still exits when the process has no reallyExit at all", async () => {
		const proc = fakeProc("linux", false);
		await hardExit(8, { proc, osExit: () => { throw new Error("no libc"); } });
		expect(proc.exit).toHaveBeenCalledWith(8);
	});
});
