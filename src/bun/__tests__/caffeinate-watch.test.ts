import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type FakeProc = { pid: number; kill: ReturnType<typeof vi.fn>; exited: Promise<number>; exit: (code: number) => void };

const procs = vi.hoisted(() => [] as FakeProc[]);

vi.mock("../spawn", () => ({
	spawn: vi.fn(() => {
		let exit: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			exit = resolve;
		});
		const proc = { pid: 1000 + procs.length, kill: vi.fn(), exited, exit };
		procs.push(proc);
		return proc;
	}),
	spawnSync: vi.fn(() => ({ exitCode: 0, stdout: Buffer.from("/usr/bin/caffeinate\n") })),
}));

vi.mock("../settings", () => ({
	loadSettingsSync: vi.fn(() => ({ preventSleepWhileRunning: true })),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { startSleepInhibitWatch, stopSleepInhibitWatch, shutdownCaffeinate, isCaffeinateRunning } from "../caffeinate";
import { loadSettingsSync } from "../settings";

const mockSettings = vi.mocked(loadSettingsSync);
const remoteOff = async () => () => false;

describe("sleep-inhibit watch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		procs.length = 0;
		mockSettings.mockReturnValue({ preventSleepWhileRunning: true } as ReturnType<typeof loadSettingsSync>);
	});

	afterEach(() => {
		shutdownCaffeinate();
		vi.useRealTimers();
	});

	it("starts the inhibit process as soon as the remote check resolves", async () => {
		startSleepInhibitWatch(remoteOff);
		await vi.advanceTimersByTimeAsync(0);
		expect(procs).toHaveLength(1);
		expect(isCaffeinateRunning()).toBe(true);
	});

	it("respawns an inhibit process that exited, on its own timer", async () => {
		startSleepInhibitWatch(remoteOff);
		await vi.advanceTimersByTimeAsync(0);

		// Long enough to count as a healthy run, then the -t timeout lapses.
		await vi.advanceTimersByTimeAsync(9_000);
		procs[0].exit(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(isCaffeinateRunning()).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(procs).toHaveLength(2);
		expect(isCaffeinateRunning()).toBe(true);
	});

	it("keeps ticking when a tick throws", async () => {
		startSleepInhibitWatch(remoteOff);
		await vi.advanceTimersByTimeAsync(0);
		procs[0].exit(0);
		await vi.advanceTimersByTimeAsync(0);

		mockSettings.mockImplementationOnce(() => {
			throw new Error("settings unreadable");
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(procs).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(procs).toHaveLength(2);
	});

	it("forces inhibition on while remote access is active, setting off", async () => {
		mockSettings.mockReturnValue({ preventSleepWhileRunning: false } as ReturnType<typeof loadSettingsSync>);
		startSleepInhibitWatch(async () => () => true);
		await vi.advanceTimersByTimeAsync(0);
		expect(isCaffeinateRunning()).toBe(true);
	});

	it("honours the user turning the setting off, and does not respawn", async () => {
		startSleepInhibitWatch(remoteOff);
		await vi.advanceTimersByTimeAsync(0);

		mockSettings.mockReturnValue({ preventSleepWhileRunning: false } as ReturnType<typeof loadSettingsSync>);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(procs[0].kill).toHaveBeenCalled();
		expect(isCaffeinateRunning()).toBe(false);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(procs).toHaveLength(1);
	});

	it("shutdown kills the process and stops the watch from starting another", async () => {
		startSleepInhibitWatch(remoteOff);
		await vi.advanceTimersByTimeAsync(0);

		shutdownCaffeinate();
		expect(procs[0].kill).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(procs).toHaveLength(1);
	});

	it("a remote check still loading at shutdown starts nothing", async () => {
		let resolveReader: (reader: () => boolean) => void = () => {};
		startSleepInhibitWatch(() => new Promise((resolve) => { resolveReader = resolve; }));
		shutdownCaffeinate();
		resolveReader(() => true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(procs).toHaveLength(0);
	});

	it("stopping the watch leaves a running inhibit process alone", async () => {
		startSleepInhibitWatch(remoteOff);
		await vi.advanceTimersByTimeAsync(0);
		stopSleepInhibitWatch();
		expect(procs[0].kill).not.toHaveBeenCalled();
		expect(isCaffeinateRunning()).toBe(true);
	});
});
