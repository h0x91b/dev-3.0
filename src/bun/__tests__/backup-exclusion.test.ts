import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.fn((..._args: unknown[]) => ({
	exited: Promise.resolve(0),
}));

vi.mock("../spawn", () => ({
	spawn: (...args: unknown[]) => mockSpawn(...args),
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
	_resetBackupExclusionGuard,
	ensureWorktreesBackupExclusion,
	WORKTREES_ROOT,
} from "../backup-exclusion";

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

const ORIGINAL_PLATFORM = process.platform;

describe("ensureWorktreesBackupExclusion", () => {
	beforeEach(() => {
		mockSpawn.mockClear();
		mockSpawn.mockReturnValue({ exited: Promise.resolve(0) });
		_resetBackupExclusionGuard();
		setPlatform("darwin");
	});

	afterEach(() => {
		setPlatform(ORIGINAL_PLATFORM);
	});

	it("runs tmutil addexclusion on the worktrees root on macOS", async () => {
		await ensureWorktreesBackupExclusion();

		expect(mockSpawn).toHaveBeenCalledWith(["mkdir", "-p", WORKTREES_ROOT]);
		expect(mockSpawn).toHaveBeenCalledWith([
			"tmutil",
			"addexclusion",
			WORKTREES_ROOT,
		]);
	});

	it("is a no-op on Linux", async () => {
		setPlatform("linux");
		await ensureWorktreesBackupExclusion();
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("only invokes tmutil once per process after success", async () => {
		await ensureWorktreesBackupExclusion();
		await ensureWorktreesBackupExclusion();
		const addexclusionCalls = mockSpawn.mock.calls.filter(
			(call) => (call[0] as string[])[0] === "tmutil",
		);
		expect(addexclusionCalls).toHaveLength(1);
	});

	it("retries on a later call when tmutil fails", async () => {
		mockSpawn.mockImplementation((...args: unknown[]) => {
			const code = (args[0] as string[])[0] === "tmutil" ? 1 : 0;
			return { exited: Promise.resolve(code) };
		});
		await ensureWorktreesBackupExclusion();

		mockSpawn.mockReturnValue({ exited: Promise.resolve(0) });
		await ensureWorktreesBackupExclusion();

		const addexclusionCalls = mockSpawn.mock.calls.filter(
			(call) => (call[0] as string[])[0] === "tmutil",
		);
		expect(addexclusionCalls).toHaveLength(2);
	});

	it("never throws when spawn rejects", async () => {
		mockSpawn.mockImplementation(() => {
			throw new Error("spawn boom");
		});
		await expect(ensureWorktreesBackupExclusion()).resolves.toBeUndefined();
	});
});
