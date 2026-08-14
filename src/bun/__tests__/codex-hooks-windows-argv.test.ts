import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCodexHooksConfigOverride } from "../../shared/agent-hooks";
import {
	launchDialect,
	posixShellQuote,
	windowsNativeArgEscape,
} from "../../shared/platform-launch";

const OVERRIDE = buildCodexHooksConfigOverride({
	"C:\\Users\\user\\.dev3.0\\worktrees\\p\\abcd\\worktree/config.toml:stop:0:0": {
		trusted_hash: "sha256:44767c0f95fc4271faed596dfbca25980b76418581f7c503a9a53f5c80ca2f92",
	},
});

describe("the Codex hooks override survives Windows argv parsing", () => {
	it("carries double quotes, which is the whole problem", () => {
		expect(OVERRIDE).toContain('type="command"');
	});

	it("escapes every quote for the Win32 argv parser", () => {
		expect(windowsNativeArgEscape('a"b')).toBe('a\\"b');
		// Backslashes are only an escape in front of a quote, so a run before one
		// doubles and everything else is left exactly as written.
		expect(windowsNativeArgEscape('a\\"b')).toBe('a\\\\\\"b');
		expect(windowsNativeArgEscape("C:\\Users\\user")).toBe("C:\\Users\\user");
	});

	it("leaves POSIX byte-identical — same bytes the old quoting produced", () => {
		expect(launchDialect("darwin").quoteNativeArg(OVERRIDE)).toBe(posixShellQuote(OVERRIDE));
		expect(launchDialect("linux").quoteNativeArg(OVERRIDE)).toBe(
			launchDialect("linux").quote(OVERRIDE),
		);
		expect(launchDialect("darwin").quoteNativeArg(OVERRIDE)).not.toContain('\\"');
	});

	it("changes the Windows spelling and only the Windows spelling", () => {
		const windows = launchDialect("win32");
		expect(windows.quoteNativeArg(OVERRIDE)).not.toBe(windows.quote(OVERRIDE));
		expect(windows.quoteNativeArg(OVERRIDE)).toContain('\\"');
	});
});

/**
 * The load-bearing half, and the only one that can prove it: PowerShell hands a
 * native process one command line and escapes nothing, so whether the quotes
 * survive is decided by Windows itself. Asserting on the string we generated
 * would just re-state our own belief — this spawns the real shell and reads back
 * what a real process received in its argv.
 */
describe.skipIf(process.platform !== "win32")("real PowerShell → real argv", () => {
	function receivedArgv(quotedOverride: string): string[] {
		const dir = mkdtempSync(join(tmpdir(), "dev3-codex-argv-"));
		const echoPath = join(dir, "echo-argv.mjs");
		writeFileSync(echoPath, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf-8");

		// The production line, verbatim: `announceAndRun` is what puts an agent
		// command into a generated wrapper, and Invoke-Expression re-parses it.
		const command = `& "${process.execPath}" "${echoPath}" -c ${quotedOverride}`;
		const script = launchDialect("win32").announceAndRun("argv probe", command).join("\n");
		const scriptPath = join(dir, "probe.ps1");
		writeFileSync(scriptPath, `\uFEFF${script}\n`, "utf-8");

		const result = spawnSync(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{ encoding: "utf-8" },
		);
		expect(result.status, `powershell failed: ${result.stderr}`).toBe(0);
		const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? "";
		return JSON.parse(lastLine) as string[];
	}

	it("delivers the override to the process byte-for-byte", () => {
		const argv = receivedArgv(launchDialect("win32").quoteNativeArg(OVERRIDE));
		expect(argv[0]).toBe("-c");
		expect(argv[1]).toBe(OVERRIDE);
	});

	it("mutation guard: the old quoting loses the quotes on the way in", () => {
		// Restoring the pre-fix spelling has to break this, or the probe above is
		// measuring nothing. What Codex then receives is unparsable TOML, which it
		// falls back to reading as a plain string — the reported failure.
		const argv = receivedArgv(launchDialect("win32").quote(OVERRIDE));
		expect(argv[1]).not.toBe(OVERRIDE);
		expect(argv[1]).not.toContain('"');
	});
});
