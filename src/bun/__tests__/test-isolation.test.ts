import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { deriveTestRunRoot, testWorktreeId } from "../../../test-isolation";

describe("test process isolation", () => {
	it("derives different roots for different worktrees", () => {
		const first = deriveTestRunRoot("/repo/worktrees/alpha", "bun", 42, "/tmp");
		const second = deriveTestRunRoot("/repo/worktrees/bravo", "bun", 42, "/tmp");

		expect(first).not.toBe(second);
		expect(first).toContain(testWorktreeId("/repo/worktrees/alpha"));
		expect(second).toContain(testWorktreeId("/repo/worktrees/bravo"));
	});

	it("also separates suites and repeated processes in one worktree", () => {
		const root = "/repo/worktrees/alpha";
		expect(deriveTestRunRoot(root, "bun", 42, "/tmp"))
			.not.toBe(deriveTestRunRoot(root, "cli", 42, "/tmp"));
		expect(deriveTestRunRoot(root, "bun", 42, "/tmp"))
			.not.toBe(deriveTestRunRoot(root, "bun", 43, "/tmp"));
	});

	it("sandboxes every implicit filesystem namespace in the active worker", () => {
		const root = process.env.DEV3_TEST_ROOT;
		expect(root).toBeTruthy();
		expect(process.env.HOME).toContain(root);
		expect(tmpdir()).toContain(root);
		expect(process.env.DEV3_HOME).toContain(root);
		expect(process.env.DEV3_LOG_DIR).toContain(root);
		expect(process.env.XDG_CONFIG_HOME).toContain(root);
		expect(process.env.XDG_RUNTIME_DIR).toContain(root);
	});
});
