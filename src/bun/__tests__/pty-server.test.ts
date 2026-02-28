import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

import { existsSync } from "node:fs";
import { createSession, setOnPtyDied } from "../pty-server";

describe("pty-server — createSession with missing cwd", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should not throw when cwd does not exist", () => {
		vi.mocked(existsSync).mockReturnValue(false);

		let diedTaskId: string | null = null;
		setOnPtyDied((taskId) => {
			diedTaskId = taskId;
		});

		expect(() => {
			createSession("test-task-missing-cwd", "proj-1", "/tmp/nonexistent-path-xyz", "bash", {});
		}).not.toThrow();

		// onPtyDied should be called since spawnPty bails out
		expect(diedTaskId).toBe("test-task-missing-cwd");
	});

	it("should spawn normally when cwd exists", () => {
		vi.mocked(existsSync).mockReturnValue(true);

		expect(() => {
			createSession("test-task-normal", "proj-1", "/tmp/existing-path", "bash", {});
		}).not.toThrow();
	});
});
