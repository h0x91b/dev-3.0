import { createLogger } from "./logger";
import { spawn, spawnSync } from "./spawn";
import { defaultLaunchShellPath, setPosixDefaultShell } from "../shared/platform-launch";
import { isExecutableFile } from "./executable";
import { loadSettingsSync } from "./settings";
import {
	type PosixShellResolution,
	type ShellFlavor,
	resolvePosixShell,
	shellFlavorOf,
} from "../shared/posix-shell";

const log = createLogger("shell-env");

export function getSupportedShell(shell: string): ShellFlavor | null {
	return shellFlavorOf(shell);
}

// Shell rc files that should carry the `~/.dev3.0/bin` PATH line so the `dev3`
// CLI is reachable in every terminal — including the extra tmux panes opened
// inside a task worktree.
//
// The subtlety that makes this non-trivial is bash: a *login* interactive bash
// (macOS Terminal.app, and tmux on macOS which always spawns login shells)
// reads the login profile (`.bash_profile` → `.bash_login` → `.profile`, first
// that exists) and does NOT read `.bashrc`. A *non-login* interactive bash
// (tmux on Linux, nested shells) reads `.bashrc`. Writing only to `.bashrc`
// therefore left bash users with `dev3: command not found` in worktree panes.
// We write to both the login profile and `.bashrc` so dev3 is on PATH
// regardless of how the shell was launched.
//
// zsh reads `.zshrc` for every interactive shell (login or not), so one file
// is enough there.
//
// A plain POSIX `sh` (dash / busybox ash) reads only the login profile
// `~/.profile`; its non-login interactive rc is whatever `$ENV` points at,
// which we must not hijack for the user's own machine-wide config.
export function getShellRcFiles(shell: string, home: string, fileExists: (path: string) => boolean): string[] {
	const supportedShell = getSupportedShell(shell);
	if (supportedShell === "zsh") {
		return [`${home}/.zshrc`];
	}
	if (supportedShell === "sh") {
		return [`${home}/.profile`];
	}
	if (supportedShell === "bash") {
		const loginCandidates = [`${home}/.bash_profile`, `${home}/.bash_login`, `${home}/.profile`];
		// Append to an existing login profile to avoid shadowing: creating a
		// fresh `.bash_profile` when the user only has `.profile` would stop
		// login bash from sourcing `.profile`. If none exist, default to
		// `.bash_profile` (the conventional macOS login profile).
		const loginFile = loginCandidates.find(fileExists) ?? `${home}/.bash_profile`;
		const bashrc = `${home}/.bashrc`;
		return loginFile === bashrc ? [loginFile] : [loginFile, bashrc];
	}
	return [];
}

function decodeStdout(stdout?: Uint8Array): string {
	return stdout ? new TextDecoder().decode(stdout).trim() : "";
}

function readAccountShell(): string | null {
	const user = process.env.USER || process.env.LOGNAME;
	if (!user) return null;

	try {
		if (process.platform === "darwin") {
			const result = spawnSync(["dscl", ".", "-read", `/Users/${user}`, "UserShell"], {
				stdout: "pipe",
				stderr: "ignore",
			});
			if (result.exitCode === 0) {
				const match = decodeStdout(result.stdout).match(/^UserShell:\s+(.+)$/m);
				return match?.[1]?.trim() || null;
			}
			return null;
		}

		if (process.platform === "linux") {
			const result = spawnSync(["getent", "passwd", user], {
				stdout: "pipe",
				stderr: "ignore",
			});
			if (result.exitCode === 0) {
				const line = decodeStdout(result.stdout);
				const shell = line.split(":")[6]?.trim();
				return shell || null;
			}
		}
	} catch (err) {
		log.debug("Failed to read account shell", { user, error: String(err) });
	}

	return null;
}

// Cached with a 1-hour TTL. The user's login shell is stable but not immutable
// — some users keep dev-3.0 open for days/weeks, and they may change their
// shell mid-session (e.g. `chsh`). Reading it via `dscl` on every call adds a
// sync spawn to every task launch / cleanup script run, which is the actual
// cost we're avoiding. One refresh per hour is a fine compromise.
const USER_SHELL_TTL_MS = 60 * 60 * 1000;
let cachedResolution: PosixShellResolution | null = null;
let cachedUserShellAt = 0;
let shellPreference: ShellFlavor | undefined;
let shellPreferenceLoaded = false;

/**
 * Apply the `terminalShell` setting. Called whenever settings are saved; it
 * drops the cache so the next launched terminal uses the new shell.
 *
 * Takes the value rather than re-reading the file: the save handler calls this
 * before `saveSettings` returns, and a re-read would still see the old JSON.
 */
export function setShellPreference(preference: ShellFlavor | undefined): void {
	shellPreference = preference;
	shellPreferenceLoaded = true;
	cachedResolution = null;
	cachedUserShellAt = 0;
}

/**
 * Read the stored preference on first use rather than requiring every entry
 * point (app, headless server, e2e harness) to remember to push it in.
 */
function currentShellPreference(): ShellFlavor | undefined {
	if (!shellPreferenceLoaded) {
		try {
			shellPreference = loadSettingsSync().terminalShell;
		} catch (err) {
			log.warn("Failed to read the shell preference — auto-detecting", { error: String(err) });
			shellPreference = undefined;
		}
		shellPreferenceLoaded = true;
	}
	return shellPreference;
}

/**
 * The resolved shell, including whether the requested flavor was missing — the
 * Settings screen shows that as a warning instead of failing silently.
 */
export function resolveUserShell(): PosixShellResolution {
	const now = Date.now();
	if (cachedResolution && now - cachedUserShellAt < USER_SHELL_TTL_MS) {
		return cachedResolution;
	}
	// Windows has no login-shell record to read and no POSIX shell at all — the
	// dialect's own default (PowerShell) is the whole answer there.
	if (process.platform === "win32") {
		const path = defaultLaunchShellPath();
		cachedResolution = { path, flavor: null, requested: "auto", fellBack: false };
	} else {
		cachedResolution = resolvePosixShell({
			preference: currentShellPreference(),
			accountShell: readAccountShell(),
			envShell: process.env.SHELL ?? null,
			exists: isExecutableFile,
		});
		if (cachedResolution.fellBack) {
			log.warn("Configured shell is not installed — falling back", {
				requested: cachedResolution.requested,
				using: cachedResolution.path,
			});
		}
		// Generated wrapper scripts resolve their shell through the launch
		// dialect, which has no access to the setting; keep the two in lockstep.
		setPosixDefaultShell(cachedResolution.path);
	}
	cachedUserShellAt = now;
	return cachedResolution;
}

export function getUserShell(): string {
	return resolveUserShell().path;
}

export function _resetUserShellCacheForTests(): void {
	cachedResolution = null;
	cachedUserShellAt = 0;
	shellPreference = undefined;
	shellPreferenceLoaded = false;
	setPosixDefaultShell(null);
}

export interface ResolvedShellEnv {
	path?: string;
	lang?: string;
	xdgConfigHome?: string;
	ghConfigDir?: string;
	sshAuthSock?: string;
	/**
	 * Every exported variable from the user's login shell, minus the typed
	 * fields above (handled separately) and the runtime/internal vars in
	 * SHELL_ENV_DENYLIST. This is what lets env-based MCP servers, SDK
	 * credentials, etc. that the user exports from their `.zshrc` / `.bashrc`
	 * reach agents launched in non-interactive tmux sessions.
	 */
	fullEnv?: Record<string, string>;
}

// Variables we must NOT copy from the user's login shell into the dev3 runtime.
// Two groups:
//   1. Typed fields handled explicitly elsewhere (PATH/LANG/...): excluded here
//      so the dedicated bootstrap logic stays the single source of truth.
//   2. Per-process / per-shell runtime state that is meaningless or harmful to
//      inherit (the running shell level, current dir, last command, the bun
//      runtime's own notion of its terminal, etc.).
// Anything NOT in this set (and not matching a denied prefix) is forwarded, so
// dev3 behaves like a real terminal for the user's exported credentials.
export const SHELL_ENV_DENYLIST = new Set<string>([
	// Typed fields — owned by the dedicated bootstrap in index.ts/headless-entry.ts.
	"PATH",
	"LANG",
	"XDG_CONFIG_HOME",
	"GH_CONFIG_DIR",
	"SSH_AUTH_SOCK",
	// Per-shell / per-process runtime state.
	"_",
	"SHLVL",
	"PWD",
	"OLDPWD",
	"SHELL",
	"TERM",
	"TMPDIR",
]);

// Variable name prefixes that must never be inherited from the login shell —
// dev3's own task wiring and the bun runtime's internals.
const SHELL_ENV_DENIED_PREFIXES = ["DEV3_", "BUN_"];

// User-global env vars unrelated to dev3 that break our managed terminals; we
// strip them everywhere (login-shell inheritance + our own process.env).
export const NEUTRALIZED_ENV_VARS = new Set<string>([
	// Claude Code disables mouse handling when set, breaking click/drag copy in
	// dev3's tmux panes (which run `mouse on`).
	"CLAUDE_CODE_DISABLE_MOUSE_CLICKS",
]);

export function stripNeutralizedEnvVars(env: Record<string, string | undefined>): void {
	for (const key of NEUTRALIZED_ENV_VARS) {
		delete env[key];
	}
}

function isDeniedEnvVar(key: string): boolean {
	if (SHELL_ENV_DENYLIST.has(key)) return true;
	if (NEUTRALIZED_ENV_VARS.has(key)) return true;
	return SHELL_ENV_DENIED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// Unique marker written by awk before any env output so we can discard
// login-shell startup noise (.zshrc echoes, MOTD, etc.) that appears in stdout
// before the awk process runs.  SOH bytes (\x01) are safe — vanishingly unlikely
// in env var values, and invisible to `split("\0")`.
export const ENV_DUMP_SENTINEL = "\x01\x01DEV3ENV\x01\x01";

// Dump every exported variable of the current shell, null-delimited, so values
// containing newlines or `=` survive intact. `awk`'s ENVIRON is POSIX and works
// identically under bash and zsh on macOS (BSD) and Linux — unlike `env -0`,
// which BSD `env` on macOS does not support.
const ENV_DUMP_COMMAND = `awk 'BEGIN{printf "\\001\\001DEV3ENV\\001\\001"; for (k in ENVIRON) printf "%s=%s%c", k, ENVIRON[k], 0}'`;

function parseNullDelimitedEnv(stdout: string): Record<string, string> {
	const sentinelIdx = stdout.indexOf(ENV_DUMP_SENTINEL);
	if (sentinelIdx < 0) return {};
	const result: Record<string, string> = {};
	for (const entry of stdout.slice(sentinelIdx + ENV_DUMP_SENTINEL.length).split("\0")) {
		if (!entry) continue;
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		result[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return result;
}

async function runEnvDump(
	shell: string,
	args: string[],
	timeout: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = spawn([shell, ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), timeout);
	const exitCode = await proc.exited;
	clearTimeout(timer);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr: stderr.trim() };
}

/**
 * Resolve the user's shell environment by spawning their login shell.
 *
 * macOS .app bundles launch with a minimal environment:
 * - PATH: /usr/bin:/bin:/usr/sbin:/sbin (no homebrew, nvm, etc.)
 * - LANG: undefined (causes tmux to replace non-ASCII with underscores)
 * - GH_CONFIG_DIR / XDG_CONFIG_HOME: undefined (gh auth can look unauthenticated
 *   in the main process while working fine inside terminal shells)
 * - No user-exported credentials (MCP connection strings, API keys, ...): every
 *   env-based MCP server then fails inside agent sessions.
 *
 * This runs the user's *active* login shell (zsh, bash or sh, whichever
 * `getUserShell` reports) and captures its full exported environment so spawned processes (tmux,
 * git, gh, pbcopy, agents, MCP servers) see exactly what a real terminal would.
 */
export async function resolveShellEnv(): Promise<ResolvedShellEnv> {
	const shell = getUserShell();
	const timeout = 5_000;
	const supportedShell = getSupportedShell(shell);

	if (!supportedShell) {
		log.warn("Skipping shell environment resolution for unsupported shell", { shell });
		return {};
	}

	try {
		// `+m` disables job control (monitor). Without it, an interactive shell
		// attached to a controlling terminal (present under `bun run dev` /
		// `electrobun dev`) calls tcsetpgrp to move itself and its rc-file jobs
		// into the tty's foreground — and after it exits the foreground process
		// group is left pointing at a dead pgid, so Ctrl+C delivers SIGINT to
		// nobody and the app looks unkillable from the terminal.
		//
		// A minimal `sh` may reject that argument cluster outright, and its whole
		// exported environment is what puts PATH in every agent session — so a
		// refusal retries with the plain login form instead of leaving the app on
		// the bare `.app` PATH.
		let run = await runEnvDump(shell, ["+m", "-ilc", ENV_DUMP_COMMAND], timeout);
		if (run.exitCode !== 0 && getSupportedShell(shell) === "sh") {
			log.info("Retrying env dump without job-control flags", { shell, exitCode: run.exitCode });
			run = await runEnvDump(shell, ["-lc", ENV_DUMP_COMMAND], timeout);
		}

		if (run.exitCode !== 0) {
			log.warn("Shell exited with non-zero code", { shell, exitCode: run.exitCode, stderr: run.stderr });
			return {};
		}

		const parsed = parseNullDelimitedEnv(run.stdout);

		const pathVal = parsed.PATH?.trim();
		const langVal = parsed.LANG?.trim();
		const xdgVal = parsed.XDG_CONFIG_HOME?.trim();
		const ghVal = parsed.GH_CONFIG_DIR?.trim();
		const sshVal = parsed.SSH_AUTH_SOCK?.trim();

		const fullEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (isDeniedEnvVar(key)) continue;
			fullEnv[key] = value;
		}

		return {
			path: pathVal && pathVal.includes("/") ? pathVal : undefined,
			lang: langVal || undefined,
			xdgConfigHome: xdgVal || undefined,
			ghConfigDir: ghVal || undefined,
			sshAuthSock: sshVal || undefined,
			fullEnv,
		};
	} catch (err) {
		log.warn("Failed to resolve shell environment", {
			shell,
			error: String(err),
		});
		return {};
	}
}

/**
 * Apply the `fullEnv` portion of a resolved shell environment to `process.env`.
 * Used by both the GUI entry (index.ts) and the headless entry (headless-entry.ts)
 * to avoid duplicating the injection loop and its logging.
 */
export function applyFullShellEnvToProcess(shellEnv: ResolvedShellEnv, importEnabled: boolean): void {
	// Strip hostile third-party vars unconditionally — they can also arrive from
	// the launch terminal (e.g. `bun run dev`), not just the login shell.
	stripNeutralizedEnvVars(process.env);

	if (!shellEnv.fullEnv) return;
	if (importEnabled) {
		let injected = 0;
		for (const [key, value] of Object.entries(shellEnv.fullEnv)) {
			process.env[key] = value;
			injected++;
		}
		log.info("Inherited user shell environment", { injected });
	} else {
		log.info("importShellEnv disabled — skipping full shell env inheritance");
	}
}
