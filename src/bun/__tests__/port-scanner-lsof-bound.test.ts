import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
	clearProcessInfoCache,
	getLsofOutput,
	getPortsForTask,
	schedulePortScanSoon,
	startPortScanPoller,
	stopPortScanPoller,
} from "../port-scanner";
import { LISTEN_SCAN_TIMEOUT_MS } from "../lsof-scan";
import { spawn } from "../spawn";

const mockSpawn = vi.mocked(spawn);
const TASK = "task-lsof-bound-1";
const LISTEN = "p100\ncnode\nn*:3000\n";

function doneProc(stdout: string, exitCode = 0) {
	return { pid: 0, stdout, stderr: "", exited: Promise.resolve(exitCode), kill: vi.fn() };
}

/** An lsof that answers only when the test says so, and dies on SIGTERM. */
function heldLsof() {
	let exit: (code: number) => void = () => {};
	let push: (text: string) => void = () => {};
	let close: () => void = () => {};
	const exited = new Promise<number>((resolve) => (exit = resolve));
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			push = (text) => controller.enqueue(new TextEncoder().encode(text));
			close = () => controller.close();
		},
	});
	const kill = vi.fn((signal: string) => {
		if (signal === "SIGTERM") exit(143);
	});
	const proc = { pid: 0, stdout, stderr: "", exited, kill };
	return {
		proc,
		answer(text: string) {
			push(text);
			close();
			exit(0);
		},
	};
}

let lsofQueue: Array<ReturnType<typeof heldLsof>["proc"] | ReturnType<typeof doneProc>> = [];

function lsofCalls(): number {
	return mockSpawn.mock.calls.filter(([cmd]) => (cmd as string[])[0] === "lsof").length;
}

function routeSpawn() {
	mockSpawn.mockImplementation(((cmd: string[]) => {
		if (cmd[0] === "ps") return doneProc("  100     1   50000   0.0\n");
		if (cmd[0] === "lsof") return lsofQueue.shift() ?? doneProc(LISTEN);
		if (cmd.includes("list-panes")) return doneProc("100\tdev3-task-lso\n");
		return doneProc("", 1);
	}) as never);
}

describe("port poller against a slow lsof", () => {
	const push = vi.fn();
	const sessions = vi.fn(() => [{ taskId: TASK, tmuxSocket: "dev3" }]);

	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawn.mockReset();
		push.mockClear();
		sessions.mockClear();
		clearProcessInfoCache();
		lsofQueue = [];
		routeSpawn();
	});

	afterEach(() => {
		stopPortScanPoller();
		vi.useRealTimers();
	});

	it("folds dev-server refreshes during a running scan into ONE follow-up, never a second chain", async () => {
		const held = heldLsof();
		lsofQueue.push(held.proc);
		startPortScanPoller(push, sessions);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(lsofCalls()).toBe(1);

		// Several run/stop notifications land while lsof is still scanning.
		for (let i = 0; i < 5; i++) {
			schedulePortScanSoon();
			await vi.advanceTimersByTimeAsync(1_000);
		}
		expect(lsofCalls()).toBe(1);

		held.answer(LISTEN);
		await vi.advanceTimersByTimeAsync(400);
		expect(lsofCalls()).toBe(2);

		// Steady state afterwards: exactly one scan per interval.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(lsofCalls()).toBe(5);
	});

	it("keeps the last known ports when a scan times out, stops it, and backs off", async () => {
		startPortScanPoller(push, sessions);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getPortsForTask(TASK)).toEqual([{ port: 3000, pid: 100, processName: "node" }]);
		push.mockClear();

		const hung = heldLsof();
		lsofQueue.push(hung.proc);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(lsofCalls()).toBe(2);

		await vi.advanceTimersByTimeAsync(LISTEN_SCAN_TIMEOUT_MS + 1_000);
		expect(hung.proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(push).not.toHaveBeenCalled();
		expect(getPortsForTask(TASK)).toEqual([{ port: 3000, pid: 100, processName: "node" }]);

		// One failure doubles the interval: nothing at +10 s, a fresh scan by +20 s.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(lsofCalls()).toBe(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(lsofCalls()).toBe(3);
	});

	it("stops the running scan on shutdown and never polls again", async () => {
		const held = heldLsof();
		lsofQueue.push(held.proc);
		startPortScanPoller(push, sessions);
		await vi.advanceTimersByTimeAsync(10_000);

		stopPortScanPoller();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(held.proc.kill).toHaveBeenCalledWith("SIGTERM");

		schedulePortScanSoon();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(lsofCalls()).toBe(1);
		expect(sessions).toHaveBeenCalledTimes(1);
	});

	it("restarting the poller leaves one chain, not two", async () => {
		startPortScanPoller(push, sessions);
		startPortScanPoller(push, sessions);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(lsofCalls()).toBe(3);
	});
});

describe("getLsofOutput", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawn.mockReset();
		lsofQueue = [];
		routeSpawn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shares one running scan between concurrent callers", async () => {
		const held = heldLsof();
		lsofQueue.push(held.proc);
		const first = getLsofOutput();
		const second = getLsofOutput();
		held.answer(LISTEN);
		await expect(Promise.all([first, second])).resolves.toEqual([LISTEN, LISTEN]);
		expect(lsofCalls()).toBe(1);

		// The next call starts a fresh scan.
		await expect(getLsofOutput()).resolves.toBe(LISTEN);
		expect(lsofCalls()).toBe(2);
	});

	it("starts a new scan only after a timed-out one was stopped", async () => {
		const hung = heldLsof();
		lsofQueue.push(hung.proc);
		const first = getLsofOutput();
		await vi.advanceTimersByTimeAsync(LISTEN_SCAN_TIMEOUT_MS - 1);
		void getLsofOutput();
		expect(lsofCalls()).toBe(1);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(first).resolves.toBe("");
		expect(hung.proc.kill).toHaveBeenCalledWith("SIGTERM");
		await expect(getLsofOutput()).resolves.toBe(LISTEN);
		expect(lsofCalls()).toBe(2);
	});
});
