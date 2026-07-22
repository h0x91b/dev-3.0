import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FAKE_TERMINAL_BUFFER_LIMIT,
	FakeTerminalRegistry,
} from "../fake-terminal";
import { runFakeTerminalStress } from "../stress";

describe("FakeTerminalRegistry", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("keeps output, input, and resize channels isolated by pane id", () => {
		const registry = new FakeTerminalRegistry({ outputIntervalMs: 100 });
		registry.reconcile(["pane-1", "pane-2"]);
		const first = registry.get("pane-1")!;
		const second = registry.get("pane-2")!;
		const firstOutput = vi.fn();
		const secondOutput = vi.fn();
		const firstInput = vi.fn();
		const secondInput = vi.fn();
		const firstResize = vi.fn();
		const secondResize = vi.fn();
		first.subscribeOutput(firstOutput);
		second.subscribeOutput(secondOutput);
		first.subscribeInput(firstInput);
		second.subscribeInput(secondInput);
		first.subscribeResize(firstResize);
		second.subscribeResize(secondResize);
		firstOutput.mockClear();
		secondOutput.mockClear();

		first.emitScriptedOutput();
		first.writeInput("echo alpha");
		first.resize(100, 30);

		expect(firstOutput).toHaveBeenCalled();
		expect(firstInput).toHaveBeenCalledWith({ paneId: "pane-1", data: "echo alpha" });
		expect(firstResize).toHaveBeenCalledWith({ paneId: "pane-1", columns: 100, rows: 30 });
		expect(secondOutput).not.toHaveBeenCalled();
		expect(secondInput).not.toHaveBeenCalled();
		expect(secondResize).not.toHaveBeenCalled();
		expect(first.streamId).toBe("fake-terminal:pane-1");
		expect(registry.ensure("pane-1")).toBe(first);

		registry.dispose();
	});

	it("caps replay memory and releases timers and subscriptions on close and unmount", () => {
		const registry = new FakeTerminalRegistry({ outputIntervalMs: 10 });
		const paneIds = Array.from({ length: 6 }, (_, index) => `pane-${index + 1}`);
		registry.reconcile(paneIds);
		const unsubscribers = paneIds.flatMap((paneId) => {
			const stream = registry.get(paneId)!;
			return [
				stream.subscribeOutput(() => {}),
				stream.subscribeInput(() => {}),
				stream.subscribeResize(() => {}),
			];
		});

		for (let index = 0; index < FAKE_TERMINAL_BUFFER_LIMIT + 50; index++) {
			registry.get("pane-1")!.emitScriptedOutput();
		}
		expect(registry.get("pane-1")!.getOutputLines()).toHaveLength(FAKE_TERMINAL_BUFFER_LIMIT);
		expect(registry.diagnostics()).toMatchObject({
			activeSessions: 6,
			runningTimers: 6,
			outputSubscriptions: 6,
			inputSubscriptions: 6,
			resizeSubscriptions: 6,
		});

		registry.reconcile(paneIds.slice(0, 3));
		expect(registry.diagnostics()).toMatchObject({
			activeSessions: 3,
			runningTimers: 3,
			disposedSessions: 3,
			outputSubscriptions: 3,
			inputSubscriptions: 3,
			resizeSubscriptions: 3,
		});

		for (const unsubscribe of unsubscribers) unsubscribe();
		registry.dispose();
		expect(registry.diagnostics()).toMatchObject({
			activeSessions: 0,
			runningTimers: 0,
			outputSubscriptions: 0,
			inputSubscriptions: 0,
			resizeSubscriptions: 0,
			disposedSessions: 6,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("runs a reproducible stress case and leaves no live work behind", async () => {
		const resultPromise = runFakeTerminalStress({
			paneCount: 6,
			durationMs: 120,
			outputIntervalMs: 10,
			resizeIntervalMs: 15,
		});
		await vi.advanceTimersByTimeAsync(120);
		const result = await resultPromise;

		expect(result.parameters).toEqual({
			paneCount: 6,
			durationMs: 120,
			outputIntervalMs: 10,
			resizeIntervalMs: 15,
		});
		expect(result.events.output).toBeGreaterThan(0);
		expect(result.events.resize).toBeGreaterThan(0);
		expect(result.beforeCleanup).toMatchObject({
			activeSessions: 6,
			runningTimers: 6,
			outputSubscriptions: 6,
			resizeSubscriptions: 6,
		});
		expect(result.afterCleanup).toMatchObject({
			activeSessions: 0,
			runningTimers: 0,
			outputSubscriptions: 0,
			inputSubscriptions: 0,
			resizeSubscriptions: 0,
			disposedSessions: 6,
		});
		expect(result.cleanupPassed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
