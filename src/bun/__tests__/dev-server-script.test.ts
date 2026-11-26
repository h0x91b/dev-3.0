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
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDevServerScript, scriptArgsProblem } from "../dev-server-script";

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
	"  if [ -n \"$ZSH_VERSION\" ]; then read -k 1 -s; elif [ -n \"$BASH_VERSION\" ]; then read -n 1 -s; else read -r _dev3_key; fi",
	"fi",
	'"/opt/tmux" detach-client 2>/dev/null || true',
].join("\n") + "\n";

describe("POSIX dev-server wrapper (pinned)", () => {
	it("renders the tmux flavour exactly, and the native one without just the detach line", () => {
		asPlatform("darwin");
		expect(buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: ENV_GROUPS, tmuxDetachCommand: DETACH })).toBe(POSIX_TMUX);
		// A native pane omits the detach line and nothing else.
		const script = buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: ENV_GROUPS, tmuxDetachCommand: null });
		expect(script).toBe(POSIX_TMUX.replace(`${DETACH}\n`, ""));
	});

	it("drops empty env groups instead of emitting blank paragraphs", () => {
		asPlatform("darwin");
		const script = buildDevServerScript({ devScript: "bun run dev", envGroups: [{}, { A: "1" }, {}] });
		expect(script).toBe(["#!/bin/bash", "export A='1'", "", "set -x", "bun run dev", "EXIT_CODE=$?", "set +x",
			"if [ $EXIT_CODE -ne 0 ]; then",
			"  printf '\\nProcess exited with code %s. Press any key to close.\\n' \"$EXIT_CODE\"",
			"  if [ -n \"$ZSH_VERSION\" ]; then read -k 1 -s; elif [ -n \"$BASH_VERSION\" ]; then read -n 1 -s; else read -r _dev3_key; fi",
			"fi"].join("\n") + "\n");
	});
});

describe("Windows dev-server wrapper (properties)", () => {
	const windowsScript = () => {
		asPlatform("win32");
		return buildDevServerScript({ devScript: "bun run dev", envGroups: ENV_GROUPS, tmuxDetachCommand: null });
	};

	it("spells the whole wrapper in PowerShell, with no bash left, and keeps the devScript verbatim", () => {
		const script = windowsScript();
		for (const bash of ["#!/bin/bash", "set -x", "set +x", "if [ $EXIT_CODE -ne 0 ]", "ZSH_VERSION"]) {
			expect(script, bash).not.toContain(bash);
		}
		expect(script).not.toMatch(/\bexport \w/);
		expect(script).not.toMatch(/read -n 1 -s/);
		expect(script.startsWith("$ErrorActionPreference = 'Continue'")).toBe(true);
		expect(script).toContain("$env:DEV3_TASK_ID = 'abc'");
		expect(script).toContain("Set-PSDebug -Trace 1");
		expect(script).toContain("Set-PSDebug -Trace 0");
		expect(script).toContain("if ($EXIT_CODE -ne 0) {");
		expect(script).toContain("Write-Host");
		// dev3 does not translate the user's own devScript.
		expect(buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: [], tmuxDetachCommand: null })).toContain(DEV_SCRIPT);
	});

	it("never reports a stale exit code, and never blocks on the keypress when input is redirected", () => {
		const script = windowsScript();
		// A PowerShell cmdlet leaves $LASTEXITCODE untouched, so a plain read of it
		// would report the PREVIOUS command's success for a dev server that died.
		expect(script).toContain("$EXIT_CODE = if ($null -eq $LASTEXITCODE) { if ($?) { 0 } else { 1 } } else { $LASTEXITCODE }");
		// Every non-interactive run — including the CI proof that executes this
		// script — has redirected stdin, where RawUI.ReadKey throws.
		expect(script).toContain("[Console]::IsInputRedirected");
	});
});

describe("dev-server script args", () => {
	it("appends the quoted args to the end of the user's command, and nothing without args", () => {
		asPlatform("darwin");
		const script = buildDevServerScript({ devScript: "bun run dev\n", envGroups: [], scriptArgs: ["--own-db", "a b", "it's"] });
		expect(script).toContain("\nbun run dev '--own-db' 'a b' 'it'\\''s'\nEXIT_CODE=$?");
		// No args leaves the command untouched.
		const withEmpty = buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: [], scriptArgs: [] });
		expect(withEmpty).toBe(buildDevServerScript({ devScript: DEV_SCRIPT, envGroups: [] }));
	});

	// Regression: args were glued onto the last line's TEXT, so a trailing comment
	// swallowed them while status still reported them as passed.
	it("puts the args ahead of a trailing comment", () => {
		asPlatform("darwin");
		const script = buildDevServerScript({ devScript: "cd web\nbun run dev # api", envGroups: [], scriptArgs: ["--x"] });
		expect(script).toContain("\ncd web\nbun run dev '--x' # api\nEXIT_CODE=$?");
		// A quoted or mid-word # is not a comment.
		const quoted = buildDevServerScript({ devScript: "bun run dev --tag '#a b' --url=x#y", envGroups: [], scriptArgs: ["--x"] });
		expect(quoted).toContain("\nbun run dev --tag '#a b' --url=x#y '--x'\n");
	});

	it.each([
		["bun run dev &", "ends with \"&\""],
		["bun run dev | tee log", null],
		["bun run dev \\", "ends with \"\\\""],
		["if true; then\n  bun run dev\nfi", "ends with \"fi\""],
		["( cd web && bun run dev )", "ends with \")\""],
		["bun run dev\n# trailing note", "has no command on it"],
		["echo 'unterminated", "ends inside an open quote"],
		["bun run dev --cwd=$(pwd)", null],
	])("judges the last line of %j", (devScript, reason) => {
		asPlatform("darwin");
		const problem = scriptArgsProblem(devScript);
		if (reason === null) expect(problem).toBeNull();
		else expect(problem).toContain(`that line ${reason}`);
	});

	it("refuses to build a script whose last line cannot take args, judging by each platform's escape", () => {
		asPlatform("darwin");
		expect(() => buildDevServerScript({ devScript: "bun run dev &", envGroups: [], scriptArgs: ["--x"] })).toThrow("ends with \"&\"");
		// Windows uses the PowerShell escape character for a continuation.
		asPlatform("win32");
		expect(scriptArgsProblem("bun run dev `")).toContain("ends with \"`\"");
		expect(scriptArgsProblem("bun run dev C:\\web\\")).toBeNull();
	});

	// Runs the generated file under the real shell: hostile args must arrive as
	// literal arguments, never as syntax, and args survive a trailing comment.
	it.skipIf(process.platform === "win32")("passes hostile args as literal text, past a trailing comment, under the real shell", () => {
		asPlatform("darwin");
		const dir = mkdtempSync(join(tmpdir(), "dev3-script-args-"));
		const run = (devScript: string, args: string[]) => {
			const file = join(dir, "run.sh");
			writeFileSync(file, buildDevServerScript({ devScript, envGroups: [], scriptArgs: args }));
			return execFileSync("/bin/sh", [file], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").slice(0, -1);
		};
		try {
			const args = ["a b", "it's", `x; touch ${dir}/pwned`, `$(touch ${dir}/pwned2)`];
			expect(run("printf '%s\\n'", args)).toEqual(args);
			expect(existsSync(join(dir, "pwned"))).toBe(false);
			expect(existsSync(join(dir, "pwned2"))).toBe(false);
			expect(run("printf '%s\\n' # api", ["a b", "c"])).toEqual(["a b", "c"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
