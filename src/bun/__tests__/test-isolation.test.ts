import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { testScopedPath, testSocketPath } from "../../../test-scoped-path";
import {
	INHERITED_TASK_CONTEXT_ENV,
	MAX_UNIX_SOCKET_PATH_BYTES,
	deriveTestRunRoot,
	deriveTestSocketRoot,
	testWorktreeId,
} from "../../../test-isolation";
import { resolveDev3Home } from "../../shared/dev3-home";

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
		// Derived from the sandbox HOME rather than pinned, so a suite that moves HOME
		// to its own fixture still moves the data root with it.
		expect(process.env.DEV3_HOME).toBeUndefined();
		expect(resolveDev3Home()).toContain(root);
		expect(process.env.DEV3_LOG_DIR).toContain(root);
		expect(process.env.XDG_CONFIG_HOME).toContain(root);
		expect(process.env.XDG_RUNTIME_DIR).toContain(root);
	});

	it("keeps the socket root short enough to bind, however deep the temp dir is", () => {
		// The whole point: bounded by CONSTRUCTION, not by how short this machine's
		// $TMPDIR happens to be. macOS already spends ~48 bytes on /var/folders/…,
		// and a fixture under the run root came to 119 bytes — 15 over the limit.
		const absurdTempRoot = `/var/folders/${"n".repeat(180)}/T`;
		const socketRoot = deriveTestSocketRoot("/repo/worktrees/alpha", "bun", 99999, absurdTempRoot);
		const longestFixture = join(socketRoot, `${"a".repeat(8)}-endpoint.sock`);

		expect(Buffer.byteLength(longestFixture)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
		expect(socketRoot.startsWith(absurdTempRoot)).toBe(false);
	});

	it("gives the live run a socket root that is created and under the limit", () => {
		const socketRoot = process.env.DEV3_TEST_SOCKET_ROOT;
		expect(socketRoot).toBeTruthy();
		expect(existsSync(socketRoot as string)).toBe(true);
		expect(Buffer.byteLength(testSocketPath("o.sock"))).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
	});

	it("really binds a socket at the path the helper hands out", async () => {
		// The guard above is arithmetic; this is the kernel's own verdict.
		const path = testSocketPath("bind.sock");
		const server = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(path, () => resolve());
			});
			expect(existsSync(path)).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("refuses to hand a socket path out of the deep run root", () => {
		expect(() => testScopedPath("s.sock")).toThrow(/testSocketPath/);
	});

	it("scrubs the task context of the agent that started this run", () => {
		// These suites usually run INSIDE a dev3 task pane. Leaving DEV3_TASK_SEQ or
		// DEV3_PANE_ID set would let a module quietly pick up the agent's own task
		// and produce a different verdict locally than in CI.
		for (const key of INHERITED_TASK_CONTEXT_ENV) expect(process.env[key]).toBeUndefined();
	});

	it("scrubs the native session config of the pane this run started in", () => {
		// An agent pane on the native backend exports its own host's
		// DEV3_NATIVE_SESSION_* — which a launcher test would otherwise read as if
		// the launcher had set it.
		expect(Object.keys(process.env).filter((key) => key.startsWith("DEV3_NATIVE_SESSION_"))).toEqual([]);
	});

	it("names every task-context var dev3 injects into a pane", () => {
		// A new injected var must be added to the scrub list in the same change.
		expect([...INHERITED_TASK_CONTEXT_ENV]).toEqual([
			"DEV3_TASK_ID",
			"DEV3_TASK_SEQ",
			"DEV3_TASK_TITLE",
			"DEV3_PANE_ID",
			"DEV3_WORKTREE_PATH",
			"DEV3_BRANCH_NAME",
		]);
	});
});
