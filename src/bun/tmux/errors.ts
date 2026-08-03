/**
 * Raised when a tmux command ran but exited non-zero. Carries the full
 * argument vector (excluding the binary/socket prefix), the exit code, and
 * the captured stderr so call sites can build their own user-facing messages
 * without re-parsing anything.
 */
export class TmuxError extends Error {
	readonly args: readonly string[];
	readonly exitCode: number;
	/** Trimmed stderr output of the failed command. */
	readonly stderr: string;

	constructor(args: readonly string[], exitCode: number, stderr: string) {
		const trimmed = stderr.trim();
		super(`tmux ${args[0] ?? ""} failed (exit ${exitCode}): ${trimmed || "unknown error"}`);
		this.name = "TmuxError";
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = trimmed;
	}
}

/** True for a non-zero-exit tmux failure. Robust across module boundaries. */
export function isTmuxError(err: unknown): err is TmuxError {
	return err instanceof TmuxError || (err as { name?: string })?.name === "TmuxError";
}

/**
 * Raised when tmux cannot even be *launched* — i.e. `Bun.spawn` itself throws
 * (ENOENT/EACCES) before the process starts, as opposed to tmux running and
 * exiting non-zero. Bun.spawn throws SYNCHRONOUSLY when the resolved binary
 * path can't be executed, so a plain try/catch around the spawn catches every
 * launch failure.
 *
 * On macOS the usual cause is dev3 losing Full Disk Access: sandboxed worktree
 * processes then can't reach the tmux binary (or `.git`) even though the exact
 * path resolves fine from a normal shell — the raw `posix_spawn '<path>'`
 * ENOENT is misleading because the file is right there. The message points at
 * that fix; the original error is preserved on `.cause`. See decision 123.
 *
 * Windows has no tmux at all, so the Full Disk Access advice would send the user
 * to a settings pane that does not exist — there the message says so instead.
 */
export class TmuxSpawnError extends Error {
	readonly binary: string;
	constructor(binary: string, cause: unknown, platform: NodeJS.Platform = process.platform) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		const hint =
			platform === "win32"
				? "tmux is POSIX-only and has no Windows build; this code path should not run here."
				: "The path resolves but could not be executed — on macOS this usually means dev3 lost Full Disk Access. " +
					"Re-add dev3 under System Settings → Privacy & Security → Full Disk Access, then retry.";
		super(`tmux failed to spawn (${binary}): ${reason}. ${hint}`);
		this.name = "TmuxSpawnError";
		this.binary = binary;
		this.cause = cause;
	}
}

/** True for a launch-time tmux failure. Robust across module boundaries: falls
 *  back to the name tag if a duplicated class breaks `instanceof`. */
export function isTmuxSpawnError(err: unknown): err is TmuxSpawnError {
	return err instanceof TmuxSpawnError || (err as { name?: string })?.name === "TmuxSpawnError";
}

/**
 * Raised when a tmux command was launched but did not finish inside its budget. Whether it
 * took effect is unknowable, so callers report uncertainty rather than failure; whether the
 * child itself is gone is a separate fact, carried by `stopConfirmed`.
 */
export class TmuxTimeoutError extends Error {
	readonly args: readonly string[];
	readonly timeoutMs: number;
	/** False when the child could not be confirmed gone — the caller must treat the
	 *  pane as unsafe rather than merely uncertain. */
	readonly stopConfirmed: boolean;
	constructor(args: readonly string[], timeoutMs: number, stopConfirmed = true) {
		super(
			`tmux ${args[0] ?? ""} did not finish within ${timeoutMs}ms and was ${stopConfirmed ? "killed" : "abandoned unconfirmed"}`,
		);
		this.name = "TmuxTimeoutError";
		this.args = args;
		this.timeoutMs = timeoutMs;
		this.stopConfirmed = stopConfirmed;
	}
}

/** True for a killed-on-timeout tmux command. Robust across module boundaries. */
export function isTmuxTimeoutError(err: unknown): err is TmuxTimeoutError {
	return err instanceof TmuxTimeoutError || (err as { name?: string })?.name === "TmuxTimeoutError";
}
