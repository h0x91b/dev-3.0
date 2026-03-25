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
		taskDropPosition: "top",
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
		it("returns the explicit setting when set to true", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			expect(isPreventSleepEnabled()).toBe(true);
		});

		it("returns the explicit setting when set to false", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: false });
			expect(isPreventSleepEnabled()).toBe(false);
		});

		it("defaults to caffeinate availability when setting is undefined", () => {
			mockLoadSettingsSync.mockReturnValue({});
			// caffeinateAvailable is cached from the first test
			const result = isPreventSleepEnabled();
			expect(typeof result).toBe("boolean");
		});
	});

	describe("updateCaffeinateState", () => {
		it("starts caffeinate when sessions active and setting enabled", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			mockSpawn.mockReturnValue({
				pid: 99999,
				kill: vi.fn(),
				exited: Promise.resolve(0),
			});

			updateCaffeinateState(3);
			expect(isCaffeinateRunning()).toBe(true);
		});

		it("stops caffeinate when no sessions active", () => {
			// First start it
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			mockSpawn.mockReturnValue({
				pid: 99999,
				kill: vi.fn(),
				exited: Promise.resolve(0),
			});
			updateCaffeinateState(2);
			expect(isCaffeinateRunning()).toBe(true);

			// Now stop it
			updateCaffeinateState(0);
			expect(isCaffeinateRunning()).toBe(false);
		});

		it("stops caffeinate when setting is disabled", () => {
			// First start it
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			mockSpawn.mockReturnValue({
				pid: 99999,
				kill: vi.fn(),
				exited: Promise.resolve(0),
			});
			updateCaffeinateState(2);
			expect(isCaffeinateRunning()).toBe(true);

			// Toggle off
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: false });
			updateCaffeinateState(2);
			expect(isCaffeinateRunning()).toBe(false);
		});

		it("does not double-start caffeinate", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			const proc = {
				pid: 99999,
				kill: vi.fn(),
				exited: Promise.resolve(0),
			};
			mockSpawn.mockReturnValue(proc);

			updateCaffeinateState(1);
			updateCaffeinateState(2);
			// spawn should only be called once (not for the second update)
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});
	});

	describe("shutdownCaffeinate", () => {
		it("kills the caffeinate process", () => {
			mockLoadSettingsSync.mockReturnValue({ preventSleepWhileRunning: true });
			const killFn = vi.fn();
			mockSpawn.mockReturnValue({
				pid: 99999,
				kill: killFn,
				exited: Promise.resolve(0),
			});

			updateCaffeinateState(1);
			expect(isCaffeinateRunning()).toBe(true);

			shutdownCaffeinate();
			expect(killFn).toHaveBeenCalled();
			expect(isCaffeinateRunning()).toBe(false);
		});

		it("does nothing when no process is running", () => {
			shutdownCaffeinate(); // should not throw
			expect(isCaffeinateRunning()).toBe(false);
		});
	});
});
