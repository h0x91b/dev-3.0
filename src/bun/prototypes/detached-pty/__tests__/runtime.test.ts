import { describe, expect, it } from "vitest";
import {
	MINIMUM_WINDOWS_CONPTY_BUN_VERSION,
	assertNativeTerminalRuntime,
	assertPackagedConptyRuntime,
	nativeTerminalSpawnError,
} from "../../../../shared/native-terminal-runtime";

describe("packaged native-terminal runtime", () => {
	it("accepts the first ConPTY-capable Bun release and newer versions", () => {
		expect(assertPackagedConptyRuntime("1.3.14")).toBe("1.3.14");
		expect(assertPackagedConptyRuntime("1.4.0")).toBe("1.4.0");
	});

	it("rejects a missing, malformed, prerelease, or older packaged Bun with a clear build fix", () => {
		for (const version of [undefined, "not-semver", "1.3.13", "1.3.14-beta.1", "1.3.14-canary.7"]) {
			expect(() => assertPackagedConptyRuntime(version)).toThrow(
				`Set Electrobun build.bunVersion to Bun >= ${MINIMUM_WINDOWS_CONPTY_BUN_VERSION}`,
			);
		}
	});
});

describe("native-terminal startup diagnostics", () => {
	it("rejects an incompatible packaged Windows runtime before terminal startup", () => {
		expect(() => assertNativeTerminalRuntime({ platform: "win32", bunVersion: "1.3.13" })).toThrow(
			"packaged Bun 1.3.13 lacks Windows ConPTY support",
		);
		expect(() => assertNativeTerminalRuntime({ platform: "win32", bunVersion: "1.3.13" })).toThrow(
			"Installing Bun on PATH will not change the packaged runtime",
		);
	});

	it("allows the same older runtime on POSIX where the ConPTY floor does not apply", () => {
		expect(() => assertNativeTerminalRuntime({ platform: "darwin", bunVersion: "1.3.13" })).not.toThrow();
		expect(() => assertNativeTerminalRuntime({ platform: "linux", bunVersion: "1.3.13" })).not.toThrow();
	});

	it("wraps a terminal spawn failure with the packaged version and recovery action", () => {
		const error = nativeTerminalSpawnError({
			platform: "win32",
			bunVersion: "1.3.14",
			command: "powershell.exe",
			cause: new Error("terminal option is not supported on this platform"),
		});

		expect(error.message).toContain("packaged Bun 1.3.14 could not start powershell.exe through Bun.Terminal");
		expect(error.message).toContain("Update or reinstall dev3");
		expect(error.message).toContain("terminal option is not supported on this platform");
	});
});
