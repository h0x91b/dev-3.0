import { describe, it, expect } from "vitest";
import { buildWindowsSwapScript, type WindowsSwapScriptOptions } from "../script";

const OPTS: WindowsSwapScriptOptions = {
	pid: 4321,
	version: "1.44.0",
	targetAppDir: "C:/Users/a/AppData/Local/sh.dev3/canary/app",
	newAppDir: "C:/Users/a/AppData/Local/sh.dev3/canary/self-extraction/temp-deadbeef/dev-3.0-canary",
	extractionDir: "C:/Users/a/AppData/Local/sh.dev3/canary/self-extraction/temp-deadbeef",
	launcherPath: "C:/Users/a/AppData/Local/sh.dev3/canary/app/bin/launcher.exe",
	logPath: "C:/Users/a/AppData/Local/sh.dev3/canary/dev3-update.log",
};

describe("windows swap script", () => {
	const script = buildWindowsSwapScript(OPTS);

	it("never waits on a process image name", () => {
		// The defect: `tasklist /FI "IMAGENAME eq launcher.exe"` matches EVERY such
		// process on the machine, so one stale launcher froze the update forever.
		expect(script).not.toMatch(/IMAGENAME/i);
		expect(script).not.toMatch(/bun Helper/);
	});

	it("waits on the app's own pid and gives up after a bounded time", () => {
		expect(script).toContain('tasklist /FI "PID eq 4321"');
		expect(script).toContain("if !waited! GEQ 60 goto forceclose");
	});

	it("force-closes only processes running from the folder being replaced", () => {
		expect(script).toContain("$_.Path -like 'C:\\Users\\a\\AppData\\Local\\sh.dev3\\canary\\app\\*'");
	});

	it("reports progress instead of showing a blank console", () => {
		expect(script).toContain('title dev3 update');
		expect(script).toContain('call :say "waiting for dev3 to exit (pid 4321)"');
		expect(script).toContain('call :say "  dev3 still running after !waited!s"');
		expect(script).toContain('call :say "installing 1.44.0"');
		expect(script).toContain('call :say "update complete"');
	});

	it("keeps every failure visible and never silent", () => {
		for (const branch of ["rmfailed", "launcher missing"]) expect(script).toContain(branch);
		// Both failure branches must pause so the window cannot vanish unread.
		expect(script.match(/^\s*pause$/gm)?.length ?? 0).toBe(2);
	});

	it("uses CRLF, because cmd.exe seeks the file by byte offset", () => {
		// Measured on windows-latest (run 31814660786): with LF-only endings the seek
		// lands mid-line and `call :say` dies with "cannot find the batch label".
		expect(script).not.toMatch(/[^\r]\n/);
		expect(script.split("\r\n").length).toBeGreaterThan(20);
	});

	it("never delays with `timeout`, which quits when stdin is redirected", () => {
		// Same run: under Task Scheduler / CI stdin is redirected and `timeout` exits
		// instantly with "Input redirection is not supported" — every wait becomes a
		// busy spin, so a 60s give-up fires in milliseconds.
		expect(script).not.toContain("timeout /t");
		expect(script).toContain("ping -n 2 127.0.0.1 >nul");
	});

	it("writes windows paths, never forward slashes", () => {
		expect(script).not.toMatch(/[A-Z]:\//);
		expect(script).toContain("C:\\Users\\a\\AppData\\Local\\sh.dev3\\canary\\app");
	});

	it("honours the configured waits", () => {
		const short = buildWindowsSwapScript({ ...OPTS, exitWaitSeconds: 3, removeRetries: 2 });
		expect(short).toContain("if !waited! GEQ 3 goto forceclose");
		expect(short).toContain("if !rmtry! GEQ 2 goto rmfailed");
	});
});
