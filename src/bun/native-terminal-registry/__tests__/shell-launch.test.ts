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

describe("native-session shell launch specification", () => {
	it("keeps executable, argv, cwd, and environment as separate values", () => {
		const launch = defineShellLaunchSpec({
			executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			argv: ["-NoLogo", "-NoProfile", "argument with spaces", 'quote"value', "meta&|<>^!"],
			cwd: "C:\\work trees\\Пример 日本語",
			env: { DEV3_UNICODE_VALUE: "Живой ✓ שלום" },
		});

		expect(launch).toEqual({
			executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			argv: ["-NoLogo", "-NoProfile", "argument with spaces", 'quote"value', "meta&|<>^!"],
			cwd: "C:\\work trees\\Пример 日本語",
			env: { DEV3_UNICODE_VALUE: "Живой ✓ שלום" },
		});
		expect(shellCommand(launch)).toEqual([
			"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			"-NoLogo",
			"-NoProfile",
			"argument with spaces",
			'quote"value',
			"meta&|<>^!",
		]);
	});

	it("round-trips the descriptor across host re-entry and rejects malformed input without a fallback", () => {
		const launch = defineShellLaunchSpec({
			executable: "C:\\Windows\\System32\\cmd.exe",
			argv: ["/D", "/Q"],
			cwd: "C:\\work trees\\тест",
			env: { DEV3_UNICODE_VALUE: "日本語 ✓" },
		});

		expect(decodeShellLaunchSpec(encodeShellLaunchSpec(launch))).toEqual(launch);
		expect(() => decodeShellLaunchSpec("not-json")).toThrow("invalid shell launch specification");
		expect(() => decodeShellLaunchSpec(JSON.stringify({ executable: "cmd.exe", argv: [] }))).toThrow(
			"invalid shell launch specification",
		);
		expect(() =>
			defineShellLaunchSpec({ executable: "", argv: [], cwd: "C:\\", env: {} }),
		).toThrow("invalid shell launch specification");
	});

	it("distinguishes a missing requested executable from an exact non-zero shell exit", () => {
		const launch = defineShellLaunchSpec({
			executable: "pwsh.exe",
			argv: ["-NoLogo", "-NoProfile"],
			cwd: "C:\\work",
			env: {},
		});
		const resolved = resolveShellLaunchSpec(launch, () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
		expect(resolved.executable).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
		expect(resolved.argv).toEqual(launch.argv);

		let missing: unknown;
		try {
			resolveShellLaunchSpec(launch, () => null);
		} catch (error) {
			missing = error;
		}
		expect(missing).toBeInstanceOf(ShellExecutableNotFoundError);
		expect(missing).toMatchObject({ code: "executable-not-found", executable: "pwsh.exe" });
		expect(shellExitVerdict(37)).toEqual({ kind: "shell-command-failed", code: 37 });
		expect(shellExitVerdict(0)).toEqual({ kind: "success", code: 0 });
		expect(shellExitVerdict(null)).toEqual({ kind: "terminated-without-exit-code", code: null });
	});

	it("maps every required Windows shell to one explicit executable and argv", () => {
		const cases: Array<[RequiredWindowsShell, string, string[]]> = [
			[
				"windows-powershell-5.1",
				"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				["-NoLogo", "-NoProfile", "-NoExit"],
			],
			[
				"powershell-7",
				"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				["-NoLogo", "-NoProfile", "-NoExit"],
			],
			[
				"cmd",
				"C:\\Windows\\System32\\cmd.exe",
				["/D", "/Q", "/V:OFF"],
			],
		];

		for (const [shell, executable, expectedArgv] of cases) {
			const launch = windowsShellLaunchSpec(shell, {
				executable,
				cwd: "C:\\proof dir\\Живой 日本語",
				env: { DEV3_UNICODE_VALUE: "✓" },
			});
			expect(launch.executable).toBe(executable);
			expect(launch.argv).toEqual(expectedArgv);
		}
	});

	it("selects the registry default explicitly and never substitutes another Windows shell", () => {
		const launch = defaultNativeShellLaunchSpec({
			platform: "win32",
			cwd: "C:\\work",
			env: { SystemRoot: "C:\\Windows" },
		});
		expect(launch).toEqual({
			executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			argv: ["-NoLogo", "-NoProfile", "-NoExit"],
			cwd: "C:\\work",
			env: {},
		});
		expect(() => defaultNativeShellLaunchSpec({ platform: "win32", cwd: "C:\\work", env: {} })).toThrow(
			"SystemRoot is required",
		);
	});
});
