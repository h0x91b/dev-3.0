/**
 * The dev-server pane's wrapper script, per dialect (Seq 1546).
 *
 * POSIX is pinned as literal text: macOS and Linux users must keep the wrapper
 * they have. Three lines DID move, deliberately, and they are pinned in their new
 * form because reproducing the old spelling would have meant inventing dialect
 * members that duplicate `print` and `readKey`:
 *   `echo ""` + `echo "…$EXIT_CODE…"`  →  one `printf '\n…%s…\n' "$EXIT_CODE"`
 *   `read -n 1 -s`                     →  the shell-portable read (identical under
 *                                         bash, which is what launches this file)
 * Nothing else changes, and the pane prints the same characters as before.
 *
 * Windows is asserted by PROPERTY — there is no previous text to match, and the
 * properties chosen are the ones whose absence is silent rather than loud.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildDevServerScript } from "../dev-server-script";

const realPlatform = process.platform;
const realSystemRoot = process.env.SystemRoot;

function asPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	if (platform === "win32") process.env.SystemRoot ??= "C:\\Windows";
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
	if (realSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = realSystemRoot;
});

const ENV_GROUPS: Record<string, string>[] = [
	{ FOO: "bar baz" },
	{ DEV3_TASK_ID: "abc", DEV3_TASK_TITLE: "Port the pane" },
	{ DEV3_PORT0: "5173" },
];
const DEV_SCRIPT = "VITE_PORT=${DEV3_PORT0:-5173} bun run dev";
const DETACH = '"/opt/tmux" detach-client 2>/dev/null || true';

const POSIX_TMUX = [
	"#!/bin/bash",
	"export FOO='bar baz'",
	"",
	"export DEV3_TASK_ID='abc'",
	"export DEV3_TASK_TITLE='Port the pane'",
	"",
	"export DEV3_PORT0='5173'",
	"",
	"set -x",
	"VITE_PORT=${DEV3_PORT0:-5173} bun run dev",
	"EXIT_CODE=$?",
	"set +x",
	"if [ $EXIT_CODE -ne 0 ]; then",
	"  printf '\\nProcess exited with code %s. Press any key to close.\\n' \"$EXIT_CODE\"",
	"  if [ -n \"$ZSH_VERSION\" ]; then read -k 1 -s; else read -n 1 -s; fi",
	"fi",
	'"/opt/tmux" detach-client 2>/dev/null || true',
].join("\n") + "\n";

describe("POSIX dev-server wrapper (pinned)", () => {
	it("renders the tmux flavour exactly", () => {
		asPlatform("darwin");
		expect(buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: ENV_GROUPS, tmuxDetachCommand: DETACH })).toBe(POSIX_TMUX);
	});

	it("omits the detach line for a native pane and nothing else", () => {
		asPlatform("darwin");
		const script = buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: ENV_GROUPS, tmuxDetachCommand: null });
		expect(script).toBe(POSIX_TMUX.replace(`${DETACH}\n`, ""));
	});

	it("drops empty env groups instead of emitting blank paragraphs", () => {
		asPlatform("darwin");
		const script = buildDevServerScript({ devScript: "bun run dev", envGroups: [{}, { A: "1" }, {}] });
		expect(script).toBe(["#!/bin/bash", "export A='1'", "", "set -x", "bun run dev", "EXIT_CODE=$?", "set +x",
			"if [ $EXIT_CODE -ne 0 ]; then",
			"  printf '\\nProcess exited with code %s. Press any key to close.\\n' \"$EXIT_CODE\"",
			"  if [ -n \"$ZSH_VERSION\" ]; then read -k 1 -s; else read -n 1 -s; fi",
			"fi"].join("\n") + "\n");
	});
});

describe("Windows dev-server wrapper (properties)", () => {
	const windowsScript = () => {
		asPlatform("win32");
		return buildDevServerScript({ devScript: "bun run dev", envGroups: ENV_GROUPS, tmuxDetachCommand: null });
	};

	it("carries no bash spelling at all", () => {
		const script = windowsScript();
		expect(script).not.toContain("#!/bin/bash");
		expect(script).not.toContain("set -x");
		expect(script).not.toContain("set +x");
		expect(script).not.toContain("if [ $EXIT_CODE -ne 0 ]");
		expect(script).not.toMatch(/\bexport \w/);
		expect(script).not.toMatch(/read -n 1 -s/);
		expect(script).not.toContain("ZSH_VERSION");
	});

	it("spells the whole wrapper in PowerShell", () => {
		const script = windowsScript();
		expect(script.startsWith("$ErrorActionPreference = 'Continue'")).toBe(true);
		expect(script).toContain("$env:DEV3_TASK_ID = 'abc'");
		expect(script).toContain("Set-PSDebug -Trace 1");
		expect(script).toContain("Set-PSDebug -Trace 0");
		expect(script).toContain("if ($EXIT_CODE -ne 0) {");
		expect(script).toContain("Write-Host");
	});

	it("reads the exit code back even when the command never set $LASTEXITCODE", () => {
		// A PowerShell cmdlet leaves $LASTEXITCODE untouched, so a plain read of it
		// would report the PREVIOUS command's success for a dev server that died.
		expect(windowsScript()).toContain("$EXIT_CODE = if ($null -eq $LASTEXITCODE) { if ($?) { 0 } else { 1 } } else { $LASTEXITCODE }");
	});

	it("never blocks forever on the keypress when input is redirected", () => {
		// Every non-interactive run — including the CI proof that executes this
		// script — has redirected stdin, where RawUI.ReadKey throws.
		expect(windowsScript()).toContain("[Console]::IsInputRedirected");
	});

	it("keeps the user's own devScript verbatim, because dev3 does not translate it", () => {
		asPlatform("win32");
		const script = buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: [], tmuxDetachCommand: null });
		expect(script).toContain(DEV_SCRIPT);
	});
});
