import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHostConfig } from "../host";
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
