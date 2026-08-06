/**
 * Both host launchers must carry the same human-readable argv0 (seq 1383) while
 * leaving the executable and the child's own argv completely alone. The second
 * half is the load-bearing one: the host asserts on `process.argv[1]` and parses
 * its verb and session id out of `argv[2..3]`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];

vi.mock("node:child_process", () => ({
	spawn: (file: string, args: string[], options: Record<string, unknown>) => {
		spawnCalls.push({ file, args, options });
		return {
			pid: 4321,
			on: () => undefined,
			unref: () => undefined,
		};
	},
}));

const { defaultHostLauncher } = await import("../registry");
const { nativeHostLauncher } = await import("../../native-host-runtime");
const { TASK_SEQ_ENV } = await import("../process-naming");
const { defineShellLaunchSpec } = await import("../shell-launch");
const { detachedHostCwd } = await import("../paths");

const SESSION_ID = "dev3-task-11111111-2222-3333-4444-555555555555-pane-2";

function launchSpec(env: Record<string, string>) {
	return defineShellLaunchSpec({ executable: "/bin/bash", argv: ["-i"], cwd: "/tmp", env });
}

const RUNTIME = {
	kind: "packaged-image" as const,
	runtimePath: "/Applications/dev-3.0.app/Contents/native-host-image/tag/dev3-terminal-host",
	entrypointPath: "/Applications/dev-3.0.app/Contents/native-host-image/tag/dev3-terminal-host.js",
	sessionVerb: "session-host",
	origin: "test",
};

describe("host launcher process naming", () => {
	beforeEach(() => {
		spawnCalls.length = 0;
	});

	it("names the packaged host by task seq and pane", () => {
		nativeHostLauncher(RUNTIME)(SESSION_ID, { launch: launchSpec({ [TASK_SEQ_ENV]: "1383" }) }, 1);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]!.options.argv0).toBe("dev3-terminal-host seq:1383 pane:2");
	});

	it("names the source-checkout host the same way", () => {
		defaultHostLauncher(SESSION_ID, { launch: launchSpec({ [TASK_SEQ_ENV]: "1383" }) }, 1);
		expect(spawnCalls[0]!.options.argv0).toBe("dev3-terminal-host seq:1383 pane:2");
	});

	it("launches the packaged carrier itself — never a copy or a renamed binary", () => {
		nativeHostLauncher(RUNTIME)(SESSION_ID, { launch: launchSpec({}) }, 1);
		expect(spawnCalls[0]!.file).toBe(RUNTIME.runtimePath);
	});

	it("leaves the child's own argv untouched, so verb + session id still parse", () => {
		nativeHostLauncher(RUNTIME)(SESSION_ID, { launch: launchSpec({ [TASK_SEQ_ENV]: "1383" }) }, 1);
		expect(spawnCalls[0]!.args).toEqual([RUNTIME.entrypointPath, "session-host", SESSION_ID]);
	});

	it("keeps the source launcher's own argv shape too", () => {
		defaultHostLauncher(SESSION_ID, { launch: launchSpec({}) }, 1);
		const args = spawnCalls[0]!.args;
		expect(args).toHaveLength(3);
		expect(args[1]).toBe("__host");
		expect(args[2]).toBe(SESSION_ID);
	});

	it("still detaches and keeps the existing session env contract", () => {
		nativeHostLauncher(RUNTIME)(SESSION_ID, { launch: launchSpec({}), cols: 100, rows: 40 }, 1);
		const options = spawnCalls[0]!.options as { detached: boolean; env: Record<string, string> };
		expect(options.detached).toBe(true);
		expect(options.env.DEV3_NATIVE_SESSION_ID).toBe(SESSION_ID);
		expect(options.env.DEV3_NATIVE_SESSION_COLS).toBe("100");
	});

	/**
	 * A detached host outlives the app, so inheriting the app's cwd pins that
	 * directory: on Windows that made `bun run dev` unable to wipe its own build
	 * folder, and the app's cwd IS inside that folder.
	 */
	it("never inherits the app's cwd — both launchers pin the host outside any bundle", () => {
		nativeHostLauncher(RUNTIME)(SESSION_ID, { launch: launchSpec({}) }, 1);
		defaultHostLauncher(SESSION_ID, { launch: launchSpec({}) }, 1);
		expect(spawnCalls).toHaveLength(2);
		for (const call of spawnCalls) {
			expect(call.options.cwd).toBe(detachedHostCwd());
			expect(String(call.options.cwd)).not.toContain("/build/");
		}
	});

	it("falls back to the session id when the task number is absent", () => {
		defaultHostLauncher("probe-session", { launch: launchSpec({}) }, 1);
		expect(spawnCalls[0]!.options.argv0).toBe("dev3-terminal-host probe-session");
	});

	it("never leaks a title, path, or key from the launch env into argv0", () => {
		defaultHostLauncher(
			SESSION_ID,
			{
				launch: launchSpec({
					[TASK_SEQ_ENV]: "1383",
					DEV3_TASK_TITLE: "Rotate the production secret",
					DEV3_WORKTREE_PATH: "/Users/arsenyp/.dev3.0/worktrees/slug/83bffcfd/worktree",
					ANTHROPIC_API_KEY: "sk-nope",
				}),
			},
			1,
		);
		const argv0 = String(spawnCalls[0]!.options.argv0);
		expect(argv0).toBe("dev3-terminal-host seq:1383 pane:2");
		for (const secret of ["secret", "worktrees", "sk-"]) expect(argv0).not.toContain(secret);
	});
});
