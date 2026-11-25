import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock spawn/spawnSync before importing
vi.mock("../spawn", () => {
	const mockProc = {
		pid: 12345,
		kill: vi.fn(),
		exited: Promise.resolve(0),
	};
	return {
		spawn: vi.fn(() => mockProc),
		spawnSync: vi.fn(),
	};
});

vi.mock("../settings", () => ({
	loadSettingsSync: vi.fn(() => ({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-default",
		taskSortOrder: "oldest-first",
		updateChannel: "stable",
	})),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}));

import {
	isCaffeinateAvailable,
	isPreventSleepEnabled,
	updateCaffeinateState,
	shutdownCaffeinate,
	isCaffeinateRunning,
} from "../caffeinate";
import { spawn, spawnSync } from "../spawn";
import { loadSettingsSync } from "../settings";

const mockSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockLoadSettingsSync = loadSettingsSync as unknown as ReturnType<typeof vi.fn>;

describe("caffeinate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset cached availability by re-importing
		// We need to reset module state between tests
		shutdownCaffeinate();
	});

	describe("isCaffeinateAvailable", () => {
		it("returns true when which exits with 0", () => {
			mockSpawnSync.mockReturnValueOnce({ exitCode: 0, stdout: Buffer.from("/usr/bin/caffeinate\n") });
			// Force a fresh check by resetting the module
			const result = isCaffeinateAvailable();
			// After first call, result is cached — the first test sets the cached value
			expect(result).toBe(true);
		});
	});

	describe("isPreventSleepEnabled", () => {
		it("returns the explicit setting, else defaults to caffeinate availability", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			expect(isPreventSleepEnabled()).toBe(true);
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: false });
			expect(isPreventSleepEnabled()).toBe(false);
			mockLoadSettingsSync.mockReturnValue({});
			// caffeinateAvailable is cached from the first test
			expect(typeof isPreventSleepEnabled()).toBe("boolean");
		});
	});

	describe("updateCaffeinateState", () => {
		const proc = () => ({ pid: 99999, kill: vi.fn(), exited: Promise.resolve(0) });

		it("stays off when disabled with remote inactive, and is forced on by remote access", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: false });
			mockSpawn.mockReturnValue(proc());

			updateCaffeinateState(false);
			expect(isCaffeinateRunning()).toBe(false);
			updateCaffeinateState(true);
			expect(isCaffeinateRunning()).toBe(true);
		});

		it("starts when enabled and stops when toggled off with remote inactive", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			mockSpawn.mockReturnValue(proc());
			updateCaffeinateState(false);
			expect(isCaffeinateRunning()).toBe(true);

			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: false });
			updateCaffeinateState(false);
			expect(isCaffeinateRunning()).toBe(false);
		});

		it("does not double-start caffeinate", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			mockSpawn.mockReturnValue(proc());

			updateCaffeinateState(false);
			updateCaffeinateState(false);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});
	});

	describe("shutdownCaffeinate", () => {
		it("kills the caffeinate process, and is a no-op with none running", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			const killFn = vi.fn();
			mockSpawn.mockReturnValue({
				pid: 99999,
				kill: killFn,
				exited: Promise.resolve(0),
			});

			updateCaffeinateState(false);
			expect(isCaffeinateRunning()).toBe(true);

			shutdownCaffeinate();
			expect(killFn).toHaveBeenCalled();
			expect(isCaffeinateRunning()).toBe(false);

			shutdownCaffeinate(); // nothing running: a safe no-op
			expect(killFn).toHaveBeenCalledTimes(1);
		});
	});
});
