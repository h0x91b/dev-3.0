/**
 * The platform launch dialect: the ONE place that knows how dev3 spells a
 * wrapper script and how that wrapper is handed to the OS.
 *
 * dev3 drives every terminal it owns through generated wrapper scripts (task
 * run wrapper, setup/startup wrapper, agent-not-found retry wrapper, cleanup
 * script). Those were POSIX shell text stitched together at the call sites. The
 * dialect keeps the call sites structural ("print this, branch on failure, run
 * that script") and moves the spelling here, so Windows can render PowerShell
 * from the same call sites.
 *
 * Two rules govern this module:
 *  - The `posix-shell` dialect renders byte-identically to the pre-dialect
 *    strings. `platform-launch-posix-golden.test.ts` pins the full rendered
 *    wrappers; a diff there is a regression for every macOS/Linux user.
 *  - There is no blended mode. tmux is a POSIX-only backend, so any tmux-shaped
 *    builder calls {@link assertPosixLaunchDialect} and fails loudly on Windows
 *    instead of degrading into a half-working shell string.
 */

import { ENV_UNSET } from "./agent-accounts";
import {
	defaultNativeShellLaunchSpec,
	defineShellLaunchSpec,
	type ShellLaunchSpec,
} from "../bun/native-terminal-registry/shell-launch";

export type { ShellLaunchSpec };

export type LaunchDialectId = "posix-shell" | "windows-powershell";

export type LaunchTextStyle = "error" | "success" | "dim" | "bold";

export interface LaunchPrintOptions {
	/** Argument expressions substituted into the text's `%s` placeholders. */
	args?: string[];
	blankBefore?: boolean;
	blankAfter?: boolean;
}

export interface LaunchScriptOptions {
	/** POSIX only: the login shell that interprets the script. */
	shellPath?: string;
	/** Echo every executed line (`sh -x` / `Set-PSDebug -Trace 1`). */
	trace?: boolean;
}

export interface LaunchSpecOptions {
	cwd: string;
	env: Record<string, string>;
	shellPath?: string;
}

export interface LaunchDialect {
	readonly id: LaunchDialectId;
	/** Extension of generated wrapper scripts, including the dot. */
	readonly scriptExtension: string;
	/**
	 * Byte-order mark a generated script must start with.
	 *
	 * Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI, so any non-ASCII
	 * character in it decodes to mojibake — and `✓` decodes to a byte PowerShell
	 * accepts as a smart quote, which broke the whole script with
	 * `TerminatorExpectedAtEndOfString` (observed on a real Windows machine).
	 * A Cyrillic task title in an env line would break it exactly the same way.
	 */
	readonly scriptByteOrderMark: string;
	/** Expression holding the previous command's exit code. */
	readonly lastExitCodeExpr: string;
	/** Leading lines of a generated script (shebang / strict-mode prelude). */
	header(): string[];
	/** Quote a literal so the script's parser sees it as one word. */
	quote(value: string): string;
	/**
	 * Quote a literal that must reach a NATIVE executable's argv byte-for-byte.
	 *
	 * Not the same job as {@link quote}: PowerShell hands a native process one
	 * flat command line and does not escape the double quotes inside the value,
	 * so `CommandLineToArgvW` eats them on the way in. POSIX has no such step —
	 * there the two are the same function.
	 */
	quoteNativeArg(value: string): string;
	/** Set the terminal pane title (OSC 2). */
	paneTitle(title: string): string;
	/** `export K=v` / `unset K` equivalents; {@link ENV_UNSET} means remove. */
	envLines(env: Record<string, string>): string[];
	/** Wrap text in an ANSI style; the result is safe to embed in `print`. */
	style(text: string, kind: LaunchTextStyle): string;
	/** Emit one styled line, optionally with `%s` argument expressions. */
	print(text: string, options?: LaunchPrintOptions): string;
	/** Announce a command line and run it in the current view. */
	announceAndRun(label: string, command: string): string[];
	/** Store the previous exit code into `varName`. */
	captureExitCode(varName: string): string;
	/** Reference `varName` as a `print` argument expression. */
	exitCodeArg(varName: string): string;
	/** `if <varName> != 0 { fail } else { ok }`; `ok` empty omits the else arm. */
	branchOnFailure(varName: string, arms: { fail: string[]; ok?: string[] }): string[];
	/** Invoke another generated script from inside a script. */
	runScript(scriptPath: string, options?: LaunchScriptOptions): string;
	/** Hand the view over to `command` and never return to this script. */
	execReplacing(command: string): string;
	/** Path of the interactive shell binary. */
	interactiveShell(shellPath?: string): string;
	/** Command line that starts an interactive shell in the current view. */
	interactiveShellCommand(shellPath?: string): string;
	/** Read (and discard) a single keypress, optionally with a timeout. */
	readKey(options?: { timeoutSeconds?: number }): string;
	/** Read (and discard) one line of input. */
	readLine(): string;
	declareFunction(name: string, body: string[]): string[];
	callFunction(name: string): string;
	loopForever(body: string[]): string[];
	/** Run `body` when `binary` is resolvable on PATH. */
	ifCommandExists(binary: string, body: string[]): string[];
	/** Structured launch of a generated wrapper script. */
	scriptLaunch(scriptPath: string, options: LaunchSpecOptions): ShellLaunchSpec;
	/** Structured launch of a bare interactive shell. */
	interactiveShellLaunch(options: LaunchSpecOptions): ShellLaunchSpec;
}

export function indentLines(spaces: number, lines: string[]): string[] {
	const pad = " ".repeat(spaces);
	return lines.map((line) => `${pad}${line}`);
}

export function launchDialectId(platform: NodeJS.Platform = process.platform): LaunchDialectId {
	return platform === "win32" ? "windows-powershell" : "posix-shell";
}

// ---------------------------------------------------------------------------
// Shell discovery
// ---------------------------------------------------------------------------

/**
 * Windows PowerShell 5.1 — resolved through the native-registry launch spec so
 * the `%SystemRoot%` layout lives in exactly one place.
 */
export function windowsPowerShellPath(env: Record<string, string | undefined> = process.env): string {
	return defaultNativeShellLaunchSpec({ platform: "win32", cwd: ".", env }).executable;
}

/** Last resort when `%SystemRoot%` is absent: let the OS resolve it from PATH. */
export const WINDOWS_POWERSHELL_FALLBACK = "powershell.exe";

/**
 * The shell that interprets dev3's generated scripts when no explicit path is
 * given. POSIX keeps the historical `$SHELL || /bin/zsh`.
 *
 * This is called during app boot (`getUserShell`), long before a window exists,
 * so it must not throw: an unset `%SystemRoot%` degrades to a PATH lookup rather
 * than killing startup.
 */
export function defaultLaunchShellPath(
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
): string {
	if (platform !== "win32") return env.SHELL || "/bin/zsh";
	try {
		return windowsPowerShellPath(env);
	} catch {
		return WINDOWS_POWERSHELL_FALLBACK;
	}
}

const POSIX_STYLE_CODES: Record<LaunchTextStyle, string> = {
	error: "1;31",
	success: "1;32",
	dim: "2",
	bold: "1",
};

const ESC = "";

// ---------------------------------------------------------------------------
// POSIX
// ---------------------------------------------------------------------------

export function posixShellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function posixEscapeForDoubleQuotes(value: string): string {
	return value.replace(/[\\"$`!]/g, "\\$&");
}

const posixDialect: LaunchDialect = {
	id: "posix-shell",
	scriptExtension: ".sh",
	scriptByteOrderMark: "",
	lastExitCodeExpr: "$?",
	header: () => ["#!/bin/bash"],
	quote: posixShellQuote,
	quoteNativeArg: posixShellQuote,
	paneTitle: (title) => `printf '\\033]2;${title}\\033\\\\'`,
	envLines: (env) =>
		Object.entries(env).map(([key, value]) =>
			value === ENV_UNSET ? `unset ${key}` : `export ${key}=${posixShellQuote(value)}`,
		),
	style: (text, kind) => `\\033[${POSIX_STYLE_CODES[kind]}m${text}\\033[0m`,
	print: (text, options) => {
		const before = options?.blankBefore ? "\\n" : "";
		const after = options?.blankAfter ? "\\n" : "";
		const args = options?.args?.length ? ` ${options.args.join(" ")}` : "";
		return `printf '${before}${text}\\n${after}'${args}`;
	},
	announceAndRun: (label, command) => [`echo "${posixEscapeForDoubleQuotes(label)}" && ${command}`],
	captureExitCode: (varName) => `${varName}=$?`,
	exitCodeArg: (varName) => `"$${varName}"`,
	branchOnFailure: (varName, arms) => [
		`if [ $${varName} -ne 0 ]; then`,
		...arms.fail,
		...(arms.ok?.length ? ["else", ...arms.ok] : []),
		"fi",
	],
	runScript: (scriptPath, options) => {
		const parts = [posixShellQuote(getLaunchShellPath(options?.shellPath))];
		if (options?.trace) parts.push("-x");
		parts.push(posixShellQuote(scriptPath));
		return parts.join(" ");
	},
	execReplacing: (command) => `exec ${command}`,
	interactiveShell: (shellPath) => getLaunchShellPath(shellPath),
	interactiveShellCommand: (shellPath) => posixShellQuote(getLaunchShellPath(shellPath)),
	readKey: (options) => {
		// The wrapper scripts carry a `#!/bin/bash` shebang but are executed via
		// the user's login shell (shebang ignored). bash-only `read -n 1 -s` then
		// breaks under zsh, which spells "read N chars" as `-k N`.
		const t = options?.timeoutSeconds;
		const timeout = typeof t === "number" ? `-t ${t} ` : "";
		return `if [ -n "$ZSH_VERSION" ]; then read ${timeout}-k 1 -s; else read ${timeout}-n 1 -s; fi`;
	},
	readLine: () => "read -r",
	declareFunction: (name, body) => [`${name}() {`, ...body, "}"],
	callFunction: (name) => name,
	loopForever: (body) => ["while true; do", ...body, "done"],
	ifCommandExists: (binary, body) => [`if command -v ${posixShellQuote(binary)} &>/dev/null; then`, ...body, "fi"],
	scriptLaunch: (scriptPath, options) =>
		defineShellLaunchSpec({
			executable: getLaunchShellPath(options.shellPath),
			argv: [scriptPath],
			cwd: options.cwd,
			env: options.env,
		}),
	interactiveShellLaunch: (options) =>
		defineShellLaunchSpec({
			executable: getLaunchShellPath(options.shellPath),
			argv: [],
			cwd: options.cwd,
			env: options.env,
		}),
};

// ---------------------------------------------------------------------------
// Windows PowerShell
// ---------------------------------------------------------------------------

/** PowerShell single-quoted literal: the only escape is a doubled quote. */
export function powerShellQuote(value: string): string {
	return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Escape a value so a native executable's argv receives it byte-for-byte.
 *
 * Windows PowerShell 5.1 builds ONE command line for a native process and copies
 * the argument in verbatim, escaping nothing. `CommandLineToArgvW` on the other
 * side then consumes every `"` it sees, so a payload carrying quotes arrives
 * stripped — which is how dev3's `-c hooks={...}` reached Codex as an unparsable
 * blob and killed the session (Seq 1540). The `\"` spelling survives both:
 * PowerShell passes it through, and the argv parser turns it back into `"`.
 *
 * Backslashes only become an escape character when they run into a `"`, so a run
 * of them immediately before one is doubled and every other backslash is left
 * alone. A value ENDING in a backslash is the one case this cannot settle here:
 * whether it needs doubling depends on whether PowerShell wraps the argument in
 * quotes, which it decides from the value's own whitespace.
 */
export function windowsNativeArgEscape(value: string): string {
	return value.replace(/(\\*)"/g, '$1$1\\"');
}

/** Escape for a PowerShell double-quoted (interpolating) string. */
function powerShellEscapeDoubleQuoted(value: string): string {
	return value.replace(/[`"$]/g, "`$&");
}

/** Real ESC bytes cannot appear in a script literal; splice them back in. */
function powerShellRestoreEscapes(value: string): string {
	return value.replaceAll(ESC, "$([char]27)");
}

const POWERSHELL_SCRIPT_ARGS = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];

function powerShellPath(shellPath?: string): string {
	const explicit = shellPath?.trim();
	if (explicit && /powershell(\.exe)?$|pwsh(\.exe)?$/i.test(explicit)) return explicit;
	return windowsPowerShellPath();
}

const windowsDialect: LaunchDialect = {
	id: "windows-powershell",
	scriptExtension: ".ps1",
	scriptByteOrderMark: "\uFEFF",
	lastExitCodeExpr: "$LASTEXITCODE",
	// No shebang on Windows; stop on unhandled errors instead of limping on.
	header: () => ["$ErrorActionPreference = 'Continue'"],
	quote: powerShellQuote,
	quoteNativeArg: (value) => powerShellQuote(windowsNativeArgEscape(value)),
	paneTitle: (title) => `Write-Host -NoNewline "$([char]27)]2;${powerShellEscapeDoubleQuoted(title)}$([char]27)\\"`,
	envLines: (env) =>
		Object.entries(env).map(([key, value]) =>
			value === ENV_UNSET
				? `Remove-Item "Env:\\${key}" -ErrorAction SilentlyContinue`
				: `$env:${key} = ${powerShellQuote(value)}`,
		),
	style: (text, kind) => `${ESC}[${POSIX_STYLE_CODES[kind]}m${text}${ESC}[0m`,
	print: (text, options) => {
		const args = options?.args ?? [];
		let body = powerShellEscapeDoubleQuoted(text);
		if (args.length > 0) {
			body = body.replace(/[{}]/g, "$&$&");
			let index = 0;
			body = body.replace(/%s/g, () => `{${index++}}`);
		}
		const before = options?.blankBefore ? "`n" : "";
		const after = options?.blankAfter ? "`n" : "";
		const literal = `"${before}${powerShellRestoreEscapes(body)}${after}"`;
		return args.length > 0 ? `Write-Host (${literal} -f ${args.join(", ")})` : `Write-Host ${literal}`;
	},
	announceAndRun: (label, command) => [
		`Write-Host "${powerShellEscapeDoubleQuoted(label)}"`,
		`Invoke-Expression ${powerShellQuote(command)}`,
	],
	captureExitCode: (varName) =>
		`$${varName} = if ($null -eq $LASTEXITCODE) { if ($?) { 0 } else { 1 } } else { $LASTEXITCODE }`,
	exitCodeArg: (varName) => `$${varName}`,
	branchOnFailure: (varName, arms) => [
		`if ($${varName} -ne 0) {`,
		...arms.fail,
		...(arms.ok?.length ? ["} else {", ...arms.ok] : []),
		"}",
	],
	runScript: (scriptPath, options) => {
		const shell = powerShellQuote(powerShellPath(options?.shellPath));
		if (options?.trace) {
			return `& ${shell} -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Set-PSDebug -Trace 1; & ${powerShellQuote(scriptPath)}"`;
		}
		return `& ${shell} ${POWERSHELL_SCRIPT_ARGS.join(" ")} ${powerShellQuote(scriptPath)}`;
	},
	// PowerShell has no `exec`: run the command, then leave with its code so the
	// wrapper never continues past the hand-over.
	execReplacing: (command) => `${command}; exit $LASTEXITCODE`,
	interactiveShell: (shellPath) => powerShellPath(shellPath),
	interactiveShellCommand: (shellPath) => `& ${powerShellQuote(powerShellPath(shellPath))} -NoLogo -NoProfile -NoExit`,
	readKey: (options) => {
		const t = options?.timeoutSeconds;
		if (typeof t !== "number") {
			return "$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') | Out-Null";
		}
		return (
			`$__deadline = (Get-Date).AddSeconds(${t}); ` +
			"while (-not [Console]::KeyAvailable -and (Get-Date) -lt $__deadline) { Start-Sleep -Milliseconds 100 }; " +
			"if ([Console]::KeyAvailable) { [Console]::ReadKey($true) | Out-Null }"
		);
	},
	readLine: () => "Read-Host | Out-Null",
	declareFunction: (name, body) => [`function ${name} {`, ...body, "}"],
	callFunction: (name) => name,
	loopForever: (body) => ["while ($true) {", ...body, "}"],
	ifCommandExists: (binary, body) => [
		`if (Get-Command ${powerShellQuote(binary)} -ErrorAction SilentlyContinue) {`,
		...body,
		"}",
	],
	scriptLaunch: (scriptPath, options) =>
		defineShellLaunchSpec({
			executable: powerShellPath(options.shellPath),
			argv: [...POWERSHELL_SCRIPT_ARGS, scriptPath],
			cwd: options.cwd,
			env: options.env,
		}),
	interactiveShellLaunch: (options) =>
		defineShellLaunchSpec({
			executable: powerShellPath(options.shellPath),
			argv: ["-NoLogo", "-NoProfile", "-NoExit"],
			cwd: options.cwd,
			env: options.env,
		}),
};

export function launchDialect(platform: NodeJS.Platform = process.platform): LaunchDialect {
	return launchDialectId(platform) === "windows-powershell" ? windowsDialect : posixDialect;
}

/**
 * Resolve the shell that runs a generated script: an explicit path wins,
 * otherwise the platform default.
 */
export function getLaunchShellPath(shellPath?: string): string {
	return shellPath?.trim() || defaultLaunchShellPath();
}

/**
 * Guard for builders that emit tmux commands. tmux is not a Windows backend, so
 * reaching one of those builders there is a wiring bug, not a fallback case.
 */
export function assertPosixLaunchDialect(context: string, platform: NodeJS.Platform = process.platform): void {
	if (launchDialectId(platform) === "posix-shell") return;
	throw new Error(`${context} requires the tmux backend, which is POSIX-only — no Windows equivalent exists`);
}
