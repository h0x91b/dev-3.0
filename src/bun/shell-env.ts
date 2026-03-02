import { createLogger } from "./logger";
import { spawn } from "./spawn";

const log = createLogger("shell-env");

/**
 * Resolve the user's full shell environment (PATH, LANG) by spawning their login shell.
 *
 * macOS .app bundles launch with a minimal environment:
 * - PATH: /usr/bin:/bin:/usr/sbin:/sbin (no homebrew, nvm, etc.)
 * - LANG: undefined (causes tmux to replace non-ASCII with underscores)
 *
 * This function gets the real values from the user's configured shell so that
 * spawned processes (tmux, git, pbcopy, etc.) work correctly.
 */
export async function resolveShellEnv(): Promise<{ path?: string; lang?: string }> {
	const shell = process.env.SHELL || "/bin/zsh";
	const timeout = 5_000;

	try {
		const proc = spawn([shell, "-ilc", 'echo "___PATH=$PATH";echo "___LANG=$LANG"'], {
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

		for (const line of lines) {
			if (line.startsWith("___PATH=")) {
				const val = line.slice("___PATH=".length).trim();
				if (val && val.includes("/")) path = val;
			} else if (line.startsWith("___LANG=")) {
				const val = line.slice("___LANG=".length).trim();
				if (val) lang = val;
			}
		}

		return { path, lang };
	} catch (err) {
		log.warn("Failed to resolve shell environment", {
			shell,
			error: String(err),
		});
		return {};
	}
}

/**
 * @deprecated Use resolveShellEnv() instead, which also resolves LANG.
 */
export async function resolveShellPath(): Promise<string | undefined> {
	const env = await resolveShellEnv();
	return env.path;
}
