import { describe, expect, it } from "vitest";
import {
	decodeShellLaunchSpec,
	defaultNativeShellLaunchSpec,
	defineShellLaunchSpec,
	encodeShellLaunchSpec,
	resolveShellLaunchSpec,
	shellCommand,
	shellExitVerdict,
	ShellExecutableNotFoundError,
	type RequiredWindowsShell,
	windowsShellLaunchSpec,
} from "../shell-launch";

const powershellLaunch = {
	executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
	argv: ["-NoLogo", "-NoProfile", "argument with spaces", 'quote"value', "meta&|<>^!"],
	cwd: "C:\\work trees\\Пример 日本語",
	env: { DEV3_UNICODE_VALUE: "Живой ✓ שלום" },
};

function requiredWindowsLaunch(shell: RequiredWindowsShell, executable: string) {
	return windowsShellLaunchSpec(shell, {
		executable,
		cwd: "C:\\proof dir\\Живой 日本語",
		env: { DEV3_UNICODE_VALUE: "✓" },
	});
}

describe("native-session shell launch specification", () => {
	it("keeps executable, argv, cwd, and environment as separate values", () => {
		expect(defineShellLaunchSpec(powershellLaunch)).toEqual(powershellLaunch);
	});

	it("builds a process argv array without constructing a command string", () => {
		expect(shellCommand(powershellLaunch)).toEqual([powershellLaunch.executable, ...powershellLaunch.argv]);
	});

	it("round-trips the complete descriptor across host re-entry", () => {
		expect(decodeShellLaunchSpec(encodeShellLaunchSpec(powershellLaunch))).toEqual(powershellLaunch);
	});

	it("rejects malformed descriptor JSON without a fallback", () => {
		expect(() => decodeShellLaunchSpec("not-json")).toThrow("invalid shell launch specification");
	});

	it("rejects an incomplete descriptor without a fallback", () => {
		expect(() => decodeShellLaunchSpec(JSON.stringify({ executable: "cmd.exe", argv: [] }))).toThrow(
			"invalid shell launch specification",
		);
	});

	it("rejects an empty executable", () => {
		expect(() =>
			defineShellLaunchSpec({ executable: "", argv: [], cwd: "C:\\", env: {} }),
		).toThrow("invalid shell launch specification");
	});

	it("resolves only the requested executable while preserving launch fields", () => {
		const requested = { ...powershellLaunch, executable: "pwsh.exe" };
		expect(
			resolveShellLaunchSpec(requested, () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
		).toEqual(powershellLaunch);
	});

	it("reports a typed executable-not-found failure before launch", () => {
		let failure: unknown;
		try {
			resolveShellLaunchSpec({ ...powershellLaunch, executable: "pwsh.exe" }, () => null);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			name: ShellExecutableNotFoundError.name,
			code: "executable-not-found",
			executable: "pwsh.exe",
		});
	});

	it("classifies an exact non-zero shell exit", () => {
		expect(shellExitVerdict(37)).toEqual({ kind: "shell-command-failed", code: 37 });
	});

	it("classifies an exact zero shell exit", () => {
		expect(shellExitVerdict(0)).toEqual({ kind: "success", code: 0 });
	});

	it("classifies termination without an exit code", () => {
		expect(shellExitVerdict(null)).toEqual({ kind: "terminated-without-exit-code", code: null });
	});

	it("maps Windows PowerShell 5.1 to its explicit argv", () => {
		expect(
			requiredWindowsLaunch(
				"windows-powershell-5.1",
				"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			),
		).toEqual({
			executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			argv: ["-NoLogo", "-NoProfile", "-NoExit"],
			cwd: "C:\\proof dir\\Живой 日本語",
			env: { DEV3_UNICODE_VALUE: "✓" },
		});
	});

	it("maps PowerShell 7 to its explicit argv", () => {
		expect(requiredWindowsLaunch("powershell-7", "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toEqual({
			executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			argv: ["-NoLogo", "-NoProfile", "-NoExit"],
			cwd: "C:\\proof dir\\Живой 日本語",
			env: { DEV3_UNICODE_VALUE: "✓" },
		});
	});

	it("maps cmd.exe to its explicit argv", () => {
		expect(requiredWindowsLaunch("cmd", "C:\\Windows\\System32\\cmd.exe")).toEqual({
			executable: "C:\\Windows\\System32\\cmd.exe",
			argv: ["/D", "/Q", "/V:OFF"],
			cwd: "C:\\proof dir\\Живой 日本語",
			env: { DEV3_UNICODE_VALUE: "✓" },
		});
	});

	it("rejects an unknown Windows shell instead of using PowerShell arguments", () => {
		expect(() =>
			windowsShellLaunchSpec("git-bash" as RequiredWindowsShell, {
				executable: "C:\\Program Files\\Git\\bin\\bash.exe",
				cwd: "C:\\proof dir",
				env: {},
			}),
		).toThrow("unsupported Windows shell: git-bash");
	});

	it("selects Windows PowerShell 5.1 as the explicit Windows registry default", () => {
		expect(
			defaultNativeShellLaunchSpec({
				platform: "win32",
				cwd: "C:\\work",
				env: { SystemRoot: "C:\\Windows" },
			}),
		).toEqual({
			executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			argv: ["-NoLogo", "-NoProfile", "-NoExit"],
			cwd: "C:\\work",
			env: {},
		});
	});

	it("does not substitute another Windows shell when SystemRoot is missing", () => {
		expect(() =>
			defaultNativeShellLaunchSpec({ platform: "win32", cwd: "C:\\work", env: {} }),
		).toThrow("SystemRoot is required");
	});
});
