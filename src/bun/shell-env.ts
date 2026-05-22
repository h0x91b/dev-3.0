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

export function getShellRcFile(shell: string, home: string): string | null {
	const supportedShell = getSupportedShell(shell);
	if (supportedShell === "bash") {
		return `${home}/.bashrc`;
	}
	if (supportedShell === "zsh") {
		return `${home}/.zshrc`;
	}
	return null;
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

/**
 * Resolve the user's shell environment by spawning their login shell.
 *
 * macOS .app bundles launch with a minimal environment:
 * - PATH: /usr/bin:/bin:/usr/sbin:/sbin (no homebrew, nvm, etc.)
 * - LANG: undefined (causes tmux to replace non-ASCII with underscores)
 * - GH_CONFIG_DIR / XDG_CONFIG_HOME: undefined (gh auth can look unauthenticated
 *   in the main process while working fine inside terminal shells)
 *
 * This function gets the real values from the user's configured shell so that
 * spawned processes (tmux, git, gh, pbcopy, etc.) work correctly.
 */
export async function resolveShellEnv(): Promise<{
	path?: string;
	lang?: string;
	xdgConfigHome?: string;
	ghConfigDir?: string;
	sshAuthSock?: string;
}> {
	const shell = getUserShell();
	const timeout = 5_000;
	const supportedShell = getSupportedShell(shell);

	if (!supportedShell) {
		log.warn("Skipping shell environment resolution for unsupported shell", { shell });
		return {};
	}

	try {
		const proc = spawn([shell, "-ilc", [
			'echo "___PATH=$PATH"',
			'echo "___LANG=$LANG"',
			'echo "___XDG_CONFIG_HOME=$XDG_CONFIG_HOME"',
			'echo "___GH_CONFIG_DIR=$GH_CONFIG_DIR"',
			'echo "___SSH_AUTH_SOCK=$SSH_AUTH_SOCK"',
		].join(";")], {
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
		const lines = stdout.split("\n");

		let path: string | undefined;
		let lang: string | undefined;
		let xdgConfigHome: string | undefined;
		let ghConfigDir: string | undefined;
		let sshAuthSock: string | undefined;

		for (const line of lines) {
			if (line.startsWith("___PATH=")) {
				const val = line.slice("___PATH=".length).trim();
				if (val && val.includes("/")) path = val;
			} else if (line.startsWith("___LANG=")) {
				const val = line.slice("___LANG=".length).trim();
				if (val) lang = val;
			} else if (line.startsWith("___XDG_CONFIG_HOME=")) {
				const val = line.slice("___XDG_CONFIG_HOME=".length).trim();
				if (val) xdgConfigHome = val;
			} else if (line.startsWith("___GH_CONFIG_DIR=")) {
				const val = line.slice("___GH_CONFIG_DIR=".length).trim();
				if (val) ghConfigDir = val;
			} else if (line.startsWith("___SSH_AUTH_SOCK=")) {
				const val = line.slice("___SSH_AUTH_SOCK=".length).trim();
				if (val) sshAuthSock = val;
			}
		}

		return { path, lang, xdgConfigHome, ghConfigDir, sshAuthSock };
	} catch (err) {
		log.warn("Failed to resolve shell environment", {
			shell,
			error: String(err),
		});
		return {};
	}
}
