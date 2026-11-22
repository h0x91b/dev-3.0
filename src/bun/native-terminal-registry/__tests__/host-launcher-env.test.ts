/**
 * A native host outlives the app and starts shells for any task, so a host started by an app
 * that was itself started inside a dev3 pane must not inherit that pane's task wiring.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ options: { env: Record<string, string | undefined> } }> = [];

vi.mock("node:child_process", () => ({
	spawn: (_file: string, _args: string[], options: { env: Record<string, string | undefined> }) => {
		spawnCalls.push({ options });
		return { pid: 4321, on: () => undefined, unref: () => undefined };
	},
}));

const { defaultHostLauncher } = await import("../registry");
const { nativeHostLauncher } = await import("../../native-host-runtime");
const { defineShellLaunchSpec } = await import("../shell-launch");
const { _resetLaunchTaskWiringForTests, resetEnvFromDev3Pane } = await import("../../pane-launch-env");

const SESSION_ID = "dev3-task-11111111-2222-3333-4444-555555555555-pane-2";
const RUNTIME = {
	kind: "packaged-image" as const,
	runtimePath: "/Applications/dev-3.0.app/Contents/native-host-image/tag/dev3-terminal-host",
	entrypointPath: "/Applications/dev-3.0.app/Contents/native-host-image/tag/dev3-terminal-host.js",
	sessionVerb: "session-host",
	origin: "test",
};

const LAUNCH_WIRING = {
	DEV3_TASK_ID: "task-a",
	DEV3_PORT2: "17749",
	DEV3_LEAN_PROTOCOL: "1",
	DEV3_DEV_SERVER: "web",
	DEV3_ARTIFACT_TEMPLATE: "off",
	DEV3_ARTIFACT_TEMPLATE_DIR: "/projects/a/.dev3/artifact",
};

const saved = new Map<string, string | undefined>();

/** Puts the launching pane's keys in process.env and records them, as the app's first step does. */
function startAsPaneLaunchedApp(): void {
	for (const [key, value] of Object.entries(LAUNCH_WIRING)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	resetEnvFromDev3Pane({ ...LAUNCH_WIRING, DEV3_HOME: "/Users/me/.dev3.0" }, "darwin");
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
	spawnCalls.length = 0;
	_resetLaunchTaskWiringForTests();
});

describe("native host env from a pane-launched app", () => {
	const launch = defineShellLaunchSpec({ executable: "/bin/bash", argv: ["-i"], cwd: "/tmp", env: {} });

	it.each([
		["source launcher", () => defaultHostLauncher(SESSION_ID, { launch }, 1)],
		["packaged launcher", () => nativeHostLauncher(RUNTIME)(SESSION_ID, { launch }, 1)],
	])("the %s unsets the launching task's wiring", (_name, start) => {
		startAsPaneLaunchedApp();

		start();

		const env = spawnCalls[0]!.options.env;
		for (const key of Object.keys(LAUNCH_WIRING)) {
			expect(key in env).toBe(true);
			expect(env[key]).toBeUndefined();
		}
		expect(env.DEV3_NATIVE_SESSION_ID).toBe(SESSION_ID);
	});

	it("passes the app's env through unchanged when the app was not started inside a pane", () => {
		process.env.DEV3_PORT2 = "17749";
		saved.set("DEV3_PORT2", undefined);

		defaultHostLauncher(SESSION_ID, { launch }, 1);

		expect(spawnCalls[0]!.options.env.DEV3_PORT2).toBe("17749");
	});
});
