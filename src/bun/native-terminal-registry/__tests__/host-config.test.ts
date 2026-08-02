import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecord, resolveHostConfig } from "../host";
import { defineShellLaunchSpec, encodeShellLaunchSpec, NATIVE_SESSION_LAUNCH_ENV } from "../shell-launch";

describe("native-session host shell configuration", () => {
	const keys = ["DEV3_NATIVE_SESSION_ID", NATIVE_SESSION_LAUNCH_ENV] as const;
	const previous = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of keys) previous.set(key, process.env[key]);
		process.env.DEV3_NATIVE_SESSION_ID = "shell-proof";
	});

	afterEach(() => {
		for (const key of keys) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		previous.clear();
	});

	it("decodes one explicit launch descriptor without building a command string", () => {
		const launch = defineShellLaunchSpec({
			executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			argv: ["-NoLogo", "-NoProfile"],
			cwd: "C:\\work trees\\Живой 日本語",
			env: { DEV3_UNICODE_VALUE: "שלום ✓" },
		});
		process.env[NATIVE_SESSION_LAUNCH_ENV] = encodeShellLaunchSpec(launch);

		expect(resolveHostConfig()).toMatchObject({ sessionId: "shell-proof", launch });
	});

	it("rejects a missing descriptor instead of selecting another shell", () => {
		delete process.env[NATIVE_SESSION_LAUNCH_ENV];
		expect(() => resolveHostConfig()).toThrow(`${NATIVE_SESSION_LAUNCH_ENV} is required`);
	});
});

describe("native-session record identity (seq 1383)", () => {
	const fields = {
		sessionId: "dev3-task-11111111-2222-3333-4444-555555555555-pane-1",
		paneId: "pane:0",
		hostPid: 1,
		hostExecutable: "/bin/bun",
		hostStartSignature: "1@t0",
		shellPid: 2,
		shellCommand: ["/bin/bash"],
		shellStartSignature: "2@t0",
		port: 1234,
		cols: 80,
		rows: 24,
		runtimeVersion: "1.3.14",
		platform: "darwin",
		startedAt: "2026-08-02T00:00:00.000Z",
		updatedAt: "2026-08-02T00:00:00.000Z",
	};

	it("records what the host's argv0 also says", () => {
		expect(buildRecord({ ...fields, identity: { seq: "1383", paneId: "pane-1" } }).identity).toEqual({
			seq: "1383",
			paneId: "pane-1",
		});
	});

	it("omits the block entirely when nothing identifies the session", () => {
		// A non-task session's record keeps exactly the shape it had before 1383.
		expect(buildRecord({ ...fields, identity: { seq: null, paneId: null } })).not.toHaveProperty("identity");
	});

	it("records the half it knows", () => {
		expect(buildRecord({ ...fields, identity: { seq: null, paneId: "pane-2" } }).identity).toEqual({
			paneId: "pane-2",
		});
	});
});
