import { createLogger } from "./logger";
import { spawn, spawnSync } from "./spawn";

const log = createLogger("shell-env");

type SupportedShell = "bash" | "zsh";

function getShellName(shell: string): string {
	return shell.split("/").pop() || shell;
}

export function getSupportedShell(shell: string): SupportedShell | null {
	const name = getShellName(shell);
	if (name === "bash" || name === "zsh") {
		return name;
	}
	return null;
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
export function getShellRcFiles(shell: string, home: string, fileExists: (path: string) => boolean): string[] {
	const supportedShell = getSupportedShell(shell);
	if (supportedShell === "zsh") {
		return [`${home}/.zshrc`];
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
let cachedUserShell: string | null = null;
let cachedUserShellAt = 0;

export function getUserShell(): string {
	const now = Date.now();
	if (cachedUserShell && now - cachedUserShellAt < USER_SHELL_TTL_MS) {
		return cachedUserShell;
	}
	cachedUserShell = readAccountShell() || process.env.SHELL || "/bin/zsh";
	cachedUserShellAt = now;
	return cachedUserShell;
}

export function _resetUserShellCacheForTests(): void {
	cachedUserShell = null;
	cachedUserShellAt = 0;
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

function isDeniedEnvVar(key: string): boolean {
	if (SHELL_ENV_DENYLIST.has(key)) return true;
	return SHELL_ENV_DENIED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// Dump every exported variable of the current shell, null-delimited, so values
// containing newlines or `=` survive intact. `awk`'s ENVIRON is POSIX and works
// identically under bash and zsh on macOS (BSD) and Linux — unlike `env -0`,
// which BSD `env` on macOS does not support.
const ENV_DUMP_COMMAND = `awk 'BEGIN{for (k in ENVIRON) printf "%s=%s%c", k, ENVIRON[k], 0}'`;

function parseNullDelimitedEnv(stdout: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of stdout.split("\0")) {
		if (!entry) continue;
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		result[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return result;
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
 * This runs the user's *active* login shell (bash or zsh, whichever `getUserShell`
 * reports) and captures its full exported environment so spawned processes (tmux,
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
		const proc = spawn([shell, "-ilc", ENV_DUMP_COMMAND], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const timer = setTimeout(() => proc.kill(), timeout);

		const exitCode = await proc.exited;
		clearTimeout(timer);

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			log.warn("Shell exited with non-zero code", { shell, exitCode, stderr: stderr.trim() });
			return {};
		}

		const stdout = await new Response(proc.stdout).text();
		const parsed = parseNullDelimitedEnv(stdout);

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
