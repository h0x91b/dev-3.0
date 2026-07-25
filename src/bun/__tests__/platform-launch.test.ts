/**
 * The launch dialect itself: which dialect a platform selects, what the Windows
 * PowerShell flavour renders, and where the POSIX-only tmux guard fires.
 *
 * The POSIX rendering is pinned separately in
 * `platform-launch-posix-golden.test.ts` — that file is the regression net; this
 * one covers the Windows half, which no POSIX CI machine can execute.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	assertPosixLaunchDialect,
	defaultLaunchShellPath,
	launchDialect,
	launchDialectId,
	powerShellQuote,
	windowsPowerShellPath,
} from "../../shared/platform-launch";
import { ENV_UNSET } from "../../shared/agent-accounts";

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("dialect selection", () => {
	it("maps win32 to PowerShell and everything else to POSIX shell", () => {
		expect(launchDialectId("win32")).toBe("windows-powershell");
		expect(launchDialectId("darwin")).toBe("posix-shell");
		expect(launchDialectId("linux")).toBe("posix-shell");
	});

	it("names scripts per dialect", () => {
		expect(launchDialect("darwin").scriptExtension).toBe(".sh");
		expect(launchDialect("win32").scriptExtension).toBe(".ps1");
	});

	it("keeps the historical POSIX default shell", () => {
		expect(defaultLaunchShellPath("darwin", { SHELL: "/bin/fish" })).toBe("/bin/fish");
		expect(defaultLaunchShellPath("linux", {})).toBe("/bin/zsh");
	});

	it("resolves the Windows default shell from SystemRoot", () => {
		expect(defaultLaunchShellPath("win32", { SystemRoot: "C:\\Windows" })).toBe(PS);
		expect(windowsPowerShellPath({ WINDIR: "D:\\Win" })).toBe(
			"D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
	});

	// The strict resolver still refuses to guess, but the boot-path default must
	// not: `getUserShell()` runs before the first window exists, so an unset
	// %SystemRoot% has to degrade to a PATH lookup instead of killing startup.
	it("refuses to guess a Windows shell without SystemRoot", () => {
		expect(() => windowsPowerShellPath({})).toThrow(/SystemRoot/);
	});

	it("degrades the boot-path default to a PATH lookup without SystemRoot", () => {
		expect(defaultLaunchShellPath("win32", {})).toBe("powershell.exe");
	});
});

describe("Windows PowerShell dialect", () => {
	const d = launchDialect("win32");
	const originalSystemRoot = process.env.SystemRoot;

	// windowsPowerShellPath() reads the live env for the no-explicit-path cases.
	beforeAll(() => {
		process.env.SystemRoot = "C:\\Windows";
	});
	afterAll(() => {
		if (originalSystemRoot === undefined) delete process.env.SystemRoot;
		else process.env.SystemRoot = originalSystemRoot;
	});

	it("quotes by doubling single quotes, never by backslash", () => {
		expect(powerShellQuote("it's")).toBe("'it''s'");
		expect(d.quote("C:\\tmp\\a b")).toBe("'C:\\tmp\\a b'");
	});

	it("sets and removes environment variables", () => {
		expect(d.envLines({ FOO: "bar baz", GONE: ENV_UNSET })).toEqual([
			"$env:FOO = 'bar baz'",
			'Remove-Item "Env:\\GONE" -ErrorAction SilentlyContinue',
		]);
	});

	it("runs a wrapper script through -File, never through a shell string", () => {
		expect(d.runScript("C:\\tmp\\run.ps1", { shellPath: PS })).toBe(
			`& '${PS}' -NoLogo -NoProfile -ExecutionPolicy Bypass -File 'C:\\tmp\\run.ps1'`,
		);
	});

	it("traces a script with Set-PSDebug instead of sh -x", () => {
		expect(d.runScript("C:\\tmp\\setup.ps1", { shellPath: PS, trace: true })).toContain("Set-PSDebug -Trace 1");
	});

	it("emulates exec by exiting with the child's code", () => {
		expect(d.execReplacing(d.interactiveShellCommand(PS))).toBe(
			`& '${PS}' -NoLogo -NoProfile -NoExit; exit $LASTEXITCODE`,
		);
	});

	it("branches on a captured exit code with PowerShell syntax", () => {
		expect(d.captureExitCode("S")).toContain("$LASTEXITCODE");
		expect(d.branchOnFailure("S", { fail: ["  Write-Host 'no'"], ok: ["  Write-Host 'yes'"] })).toEqual([
			"if ($S -ne 0) {",
			"  Write-Host 'no'",
			"} else {",
			"  Write-Host 'yes'",
			"}",
		]);
	});

	it("prints styled text with real ESC bytes spliced in at runtime", () => {
		expect(d.print(d.style("✓ Found %s", "success"), { blankBefore: true, args: ["'claude'"] })).toBe(
			"Write-Host (\"`n$([char]27)[1;32m✓ Found {0}$([char]27)[0m\" -f 'claude')",
		);
	});

	it("escapes double quotes and dollars inside printed text", () => {
		expect(d.print('run "%s" now $x', { args: ["'claude'"] })).toBe(
			'Write-Host ("run `"{0}`" now `$x" -f \'claude\')',
		);
	});

	it("probes PATH with Get-Command and reads input with the PowerShell cmdlets", () => {
		expect(d.ifCommandExists("claude", ["  X"])).toEqual([
			"if (Get-Command 'claude' -ErrorAction SilentlyContinue) {",
			"  X",
			"}",
		]);
		expect(d.readLine()).toBe("Read-Host | Out-Null");
		expect(d.readKey()).toContain("ReadKey('NoEcho,IncludeKeyDown')");
		expect(d.readKey({ timeoutSeconds: 15 })).toContain("AddSeconds(15)");
	});

	it("uses no POSIX shell constructs anywhere in a rendered script", () => {
		const script = [
			...d.header(),
			...d.envLines({ FOO: "bar" }),
			...d.announceAndRun("Starting: claude", "claude"),
			d.captureExitCode("__EC"),
			...d.branchOnFailure("__EC", { fail: [d.print(d.style("✗ %s", "error"), { args: [d.exitCodeArg("__EC")] })] }),
			...d.loopForever([d.readLine()]),
			...d.declareFunction("check_and_run", ["  Write-Host 'x'"]),
		].join("\n");
		expect(script).not.toContain("#!/bin/bash");
		expect(script).not.toContain("export ");
		expect(script).not.toMatch(/\bprintf\b/);
		expect(script).not.toMatch(/\bexec\b/);
		expect(script).not.toMatch(/\bread -/);
		expect(script).not.toContain("&>/dev/null");
		expect(script).not.toContain("\\033");
	});

	it("launches a wrapper script as powershell.exe -File with a structured argv", () => {
		expect(d.scriptLaunch("C:\\tmp\\run.ps1", { cwd: "C:\\w\\t", env: { A: "b" } })).toEqual({
			executable: PS,
			argv: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\tmp\\run.ps1"],
			cwd: "C:\\w\\t",
			env: { A: "b" },
		});
	});

	it("launches an interactive shell that stays open", () => {
		expect(d.interactiveShellLaunch({ cwd: "C:\\w\\t", env: {} }).argv).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NoExit",
		]);
	});

	it("ignores a POSIX shell path handed down from POSIX-shaped callers", () => {
		expect(d.interactiveShell("/bin/zsh")).toBe(PS);
		expect(d.interactiveShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
			"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
		);
	});
});

describe("POSIX launch spec", () => {
	it("runs the wrapper script through the login shell", () => {
		expect(launchDialect("darwin").scriptLaunch("/tmp/run.sh", { cwd: "/w/t", env: {}, shellPath: "/bin/zsh" })).toEqual({
			executable: "/bin/zsh",
			argv: ["/tmp/run.sh"],
			cwd: "/w/t",
			env: {},
		});
	});
});

describe("tmux guard", () => {
	it("passes on POSIX and fails loudly on Windows instead of degrading", () => {
		expect(() => assertPosixLaunchDialect("the dev-server tmux session", "darwin")).not.toThrow();
		expect(() => assertPosixLaunchDialect("the dev-server tmux session", "win32")).toThrow(
			/dev-server tmux session requires the tmux backend/,
		);
	});
});
