import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The inhibit process carries a 1-hour safety timeout. When it lapsed on its own,
// an idle Mac went to sleep in the same second, before the next poll could
// respawn it. These tests pin the overlapping hand-over that replaced the lapse.

const settings = { preventSleepWhileRunning: true as boolean | undefined };

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ exitCode: 0, stdout: Buffer.from("/usr/bin/caffeinate\n") })),
}));

vi.mock("../settings", () => ({
	loadSettingsSync: vi.fn(() => ({ ...settings })),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

type FakeProc = { pid: number; kill: ReturnType<typeof vi.fn>; exited: Promise<number> };

const MINUTE = 60_000;
let events: string[] = [];
let procs: FakeProc[] = [];

function liveProc(): FakeProc {
	const pid = 100 + procs.length;
	const proc: FakeProc = {
		pid,
		kill: vi.fn(() => events.push(`kill ${pid}`)),
		exited: new Promise<number>(() => {}),
	};
	procs.push(proc);
	events.push(`spawn ${pid}`);
	return proc;
}

async function load() {
	vi.resetModules();
	const caffeinate = await import("../caffeinate");
	const { spawn } = await import("../spawn");
	const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
	mockSpawn.mockImplementation(liveProc);
	return { ...caffeinate, spawn: mockSpawn };
}

describe("caffeinate safety-timeout renewal", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		settings.preventSleepWhileRunning = true;
		events = [];
		procs = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("spawns the successor before killing the old process, with no agent activity at all", async () => {
		const { updateCaffeinateState, shutdownCaffeinate, spawn } = await load();
		updateCaffeinateState(false);
		expect(events).toEqual(["spawn 100"]);

		vi.advanceTimersByTime(54 * MINUTE);
		expect(events).toEqual(["spawn 100"]);

		vi.advanceTimersByTime(1 * MINUTE);
		expect(events).toEqual(["spawn 100", "spawn 101", "kill 100"]);
		const [cmd] = spawn.mock.calls[1] as [string[]];
		expect(cmd).toEqual(["/usr/bin/caffeinate", "-i", "-s", "-t", "3600"]);
		shutdownCaffeinate();
	});

	it("keeps renewing every 55 minutes for as long as the setting stays on", async () => {
		const { updateCaffeinateState, isCaffeinateRunning, shutdownCaffeinate } = await load();
		updateCaffeinateState(false);
		for (let hour = 0; hour < 5; hour++) {
			vi.advanceTimersByTime(55 * MINUTE);
			updateCaffeinateState(false); // the poll still runs between renewals
		}
		expect(procs).toHaveLength(6);
		expect(procs.slice(0, 5).every((p) => p.kill.mock.calls.length === 1)).toBe(true);
		expect(procs[5].kill).not.toHaveBeenCalled();
		expect(isCaffeinateRunning()).toBe(true);
		shutdownCaffeinate();
	});

	it("renews without the poll: a stalled poll must not let the lock lapse", async () => {
		const { updateCaffeinateState, shutdownCaffeinate } = await load();
		updateCaffeinateState(false);
		vi.advanceTimersByTime(3 * 55 * MINUTE);
		expect(procs).toHaveLength(4);
		shutdownCaffeinate();
	});

	it("does not renew once the user turns the setting off", async () => {
		const { updateCaffeinateState, isCaffeinateRunning } = await load();
		updateCaffeinateState(false);
		settings.preventSleepWhileRunning = false;
		updateCaffeinateState(false);
		expect(events).toEqual(["spawn 100", "kill 100"]);

		vi.advanceTimersByTime(3 * 60 * MINUTE);
		expect(events).toEqual(["spawn 100", "kill 100"]);
		expect(isCaffeinateRunning()).toBe(false);
	});

	it("keeps the old process when the successor fails to start", async () => {
		const { updateCaffeinateState, isCaffeinateRunning, spawn, shutdownCaffeinate } = await load();
		updateCaffeinateState(false);
		spawn.mockImplementationOnce(() => {
			throw new Error("posix_spawn ENOENT");
		});

		vi.advanceTimersByTime(55 * MINUTE);

		expect(procs).toHaveLength(1);
		expect(procs[0].kill).not.toHaveBeenCalled();
		expect(isCaffeinateRunning()).toBe(true);
		shutdownCaffeinate();
		expect(procs[0].kill).toHaveBeenCalledTimes(1);
	});
});
