/**
 * How generated agent commands (hooks, skills, permission rules) invoke the
 * dev3 CLI, per platform.
 *
 * POSIX keeps the frozen `~/.dev3.0/bin/dev3` string: it is embedded verbatim in
 * every worktree's `.claude/settings.local.json` and in the installed skills, and
 * an older dev3 build on the same machine still reads those files.
 *
 * Windows has neither tilde expansion nor a POSIX shell in the agents' hook
 * runners, so the command must be an absolute path to the bundled `dev3.exe`
 * with no shell operators around it.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, win32 } from "node:path";

/** Frozen POSIX invocation — do not change (see the on-disk invariants in AGENTS.md). */
export const POSIX_DEV3_CLI = "~/.dev3.0/bin/dev3";

export const WINDOWS_DEV3_CLI_BASENAME = "dev3.exe";

export interface Dev3CliLookup {
	platform?: NodeJS.Platform;
	/** `dirname(realpathSync(process.execPath))` of the running dev3 binary. */
	execDir?: string;
	/** `os.homedir()` — `%USERPROFILE%` on Windows. */
	homeDir?: string;
	exists?: (path: string) => boolean;
}

/**
 * Preference-ordered Windows locations of the CLI, as pure layout math (same
 * pattern as `bundledTmuxCandidates`): the CLI shipped next to the running
 * binary, the packaged `Resources/app` layout, then the per-user install dir
 * that `ensureDev3CliSymlink` maintains.
 */
export function windowsDev3CliCandidates(execDir?: string, homeDir?: string): string[] {
	const candidates: string[] = [];
	if (execDir) {
		candidates.push(win32.join(execDir, "cli", WINDOWS_DEV3_CLI_BASENAME));
		candidates.push(win32.resolve(execDir, "..", "Resources", "app", "cli", WINDOWS_DEV3_CLI_BASENAME));
	}
	if (homeDir) {
		candidates.push(win32.join(homeDir, ".dev3.0", "bin", WINDOWS_DEV3_CLI_BASENAME));
	}
	return candidates;
}

function currentExecDir(): string | undefined {
	try {
		return dirname(realpathSync(process.execPath));
	} catch {
		return undefined;
	}
}

/**
 * The raw (unquoted) path used to invoke the CLI. Windows falls back to the last
 * candidate when nothing exists yet — the app writes it on the next startup, and
 * an absolute path that is briefly missing beats a `~` that never expands.
 */
export function resolveDev3CliPath(lookup: Dev3CliLookup = {}): string {
	const platform = lookup.platform ?? process.platform;
	if (platform !== "win32") return POSIX_DEV3_CLI;

	const exists = lookup.exists ?? existsSync;
	const candidates = windowsDev3CliCandidates(
		lookup.execDir ?? currentExecDir(),
		lookup.homeDir ?? homedir(),
	);
	// Nothing to anchor on (no exec dir, no home): let the OS resolve it on PATH.
	if (candidates.length === 0) return WINDOWS_DEV3_CLI_BASENAME;
	return candidates.find(exists) ?? candidates[candidates.length - 1];
}

/**
 * Spell a Windows path so every hook runner we have observed can execute it.
 *
 * Claude Code runs hook commands through Git Bash (`/usr/bin/bash`), which eats
 * `\` as an escape: a bare `D:\src\dev-3.0\...\dev3.exe` arrives as
 * `D:srcdev-3.0...dev3.exe: command not found`. Forward slashes survive bash,
 * `cmd.exe` and `CreateProcess` alike, and the quotes keep a path with spaces in
 * one argument — quotes are not a shell operator, so this still runs shell-free.
 */
export function hookCliCommandPath(path: string): string {
	return `"${path.replaceAll("\\", "/")}"`;
}

/**
 * Everything platform-specific about a generated dev3 command: how to spell the
 * CLI, and whether POSIX shell syntax may appear around it.
 */
export interface HookCliDialect {
	/** Ready-to-embed dev3 CLI invocation. */
	cli: string;
	/** True when the generated command is run through a POSIX shell. */
	posixShell: boolean;
}

export function hookCliDialect(lookup: Dev3CliLookup = {}): HookCliDialect {
	const platform = lookup.platform ?? process.platform;
	if (platform !== "win32") return { cli: POSIX_DEV3_CLI, posixShell: true };
	return {
		cli: hookCliCommandPath(resolveDev3CliPath({ ...lookup, platform })),
		posixShell: false,
	};
}
