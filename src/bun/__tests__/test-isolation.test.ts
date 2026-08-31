import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { testScopedPath, testSocketPath } from "../../../test-scoped-path";
import {
	DEV3_ENV_PREFIX,
	MAX_UNIX_SOCKET_PATH_BYTES,
	PANE_INJECTED_ENV_SAMPLE,
	PRESERVED_TEST_ENV_PREFIX,
	assertDev3HomeIsSandboxed,
	cleanupTestIsolation,
	configureTestIsolation,
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

	it("leaves this run carrying no pane-injected DEV3_ var at all", () => {
		// These suites usually run INSIDE a dev3 task pane, which exports its data
		// home, its checkout, its worktree, its ports and its task. Anything that
		// survived here would let a module quietly test the agent's OWN environment.
		const root = process.env.DEV3_TEST_ROOT as string;
		// Anything left outside the harness's own DEV3_TEST_ namespace has to be a
		// path this run owns — DEV3_LOG_DIR is set by the isolation itself.
		const escaped = Object.keys(process.env)
			.filter((key) => key.startsWith(DEV3_ENV_PREFIX) && !key.startsWith(PRESERVED_TEST_ENV_PREFIX))
			.filter((key) => !process.env[key]?.startsWith(root));
		expect(escaped).toEqual([]);
	});

	it("scrubs a DEV3_ var nobody listed, including one invented after this test", () => {
		// The point of default-deny: the scrub is a prefix rule, so a var dev3 gains
		// later is dropped with nobody editing test-isolation.ts. A named list is
		// what let DEV3_HOME through while dutifully scrubbing six lesser vars.
		const injected = [...PANE_INJECTED_ENV_SAMPLE, "DEV3_SOMETHING_INVENTED_LATER"];
		withRestoredEnv(() => {
			for (const key of injected) process.env[key] = "/Users/real/leaked";
			process.env.DEV3_TEST_CONCURRENT = "1";

			const root = configureTestIsolation("guard", "/repo/worktrees/guard-scrub");
			try {
				for (const key of injected) expect(process.env[key]).toBeUndefined();
				// The harness's own namespace must survive: the Vitest config reads
				// DEV3_TEST_CONCURRENT for its worker budget right after this returns.
				expect(process.env.DEV3_TEST_CONCURRENT).toBe("1");
				expect(process.env.DEV3_TEST_ROOT).toBe(root);
			} finally {
				cleanupTestIsolation(root);
			}
		});
	});

	it("refuses to start when the data root still escapes to the real home", () => {
		// The outcome check rather than the mechanism: if a later change lets some
		// override through, the run dies here instead of writing to the live board.
		expect(() => assertDev3HomeIsSandboxed("/tmp/dev3-tests/elsewhere")).toThrow(
			/outside the run root/,
		);
	});
});

/** Run `body` with the process environment restored afterwards, whatever it did. */
function withRestoredEnv(body: () => void): void {
	const saved = { ...process.env };
	try {
		body();
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}
