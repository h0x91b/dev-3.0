import { createLogger } from "./logger";

const log = createLogger("shell-env");

/**
 * Resolve the user's full shell PATH by spawning their login shell.
 *
 * macOS .app bundles launch with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
 * This function gets the real PATH from the user's configured shell so that
 * spawned processes (tmux, git, pbcopy, etc.) can be found.
 */
export async function resolveShellPath(): Promise<string | undefined> {
	const shell = process.env.SHELL || "/bin/zsh";
	const timeout = 5_000;

	try {
		const proc = Bun.spawn([shell, "-ilc", "echo $PATH"], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: process.env.HOME },
		});

		const timer = setTimeout(() => proc.kill(), timeout);

		const exitCode = await proc.exited;
		clearTimeout(timer);

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			log.warn("Shell exited with non-zero code", { shell, exitCode, stderr: stderr.trim() });
			return undefined;
		}

		const stdout = await new Response(proc.stdout).text();
		// The last non-empty line should be the PATH
		const lines = stdout.trim().split("\n");
		const pathLine = lines[lines.length - 1]?.trim();

		if (!pathLine || !pathLine.includes("/")) {
			log.warn("Shell returned unexpected PATH output", { shell, output: stdout.trim() });
			return undefined;
		}

		return pathLine;
	} catch (err) {
		log.warn("Failed to resolve shell PATH", {
			shell,
			error: String(err),
		});
		return undefined;
	}
}
