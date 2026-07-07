import { CLI_EXIT_CODE_SUCCESS } from "../shared/cli-exit-codes";

/**
 * True when `err` is a broken-pipe (EPIPE) error, however it surfaced — a thrown
 * Error with `.code === "EPIPE"`, or a raw stream 'error' payload.
 */
export function isEpipeError(err: unknown): boolean {
	return err != null && typeof err === "object" && (err as { code?: unknown }).code === "EPIPE";
}

/**
 * Make the CLI tolerate its stdout/stderr consumer closing the pipe early —
 * `dev3 … | head`, `| grep -m1`, quitting a pager mid-output. Bun throws a
 * SYNCHRONOUS EPIPE from process.stdout.write once the read end is gone; because
 * stdout is flushed on a later tick the throw escapes the awaited call chain and
 * lands in `uncaughtException`, where Bun prints a raw "EPIPE: broken pipe"
 * stack trace and exits non-zero. Piping CLI output through head/grep is an
 * extremely common agent pattern, so that noise reads like a real failure in
 * otherwise-clean tool output (reported twice: 2026-07-04 and 2026-07-05).
 *
 * We swallow EPIPE wherever it can appear and exit 0 silently — the consumer
 * asked us to stop, so a clean exit is correct. Every other error keeps its
 * existing behavior (rethrown → the normal crash / fatal handling path).
 *
 * NOT installed for `dev3 remote` / `dev3 gui`: those are long-running and
 * register their own crash handlers that log-and-continue, so an extra
 * rethrowing uncaughtException listener would defeat that (see main.ts).
 */
export function installEpipeGuard(): void {
	const swallowEpipe = (err: unknown): void => {
		if (isEpipeError(err)) {
			// The reader is gone; abandon the rest of the output and exit cleanly.
			process.exit(CLI_EXIT_CODE_SUCCESS);
		}
		// Preserve default behavior for anything that is not a broken pipe.
		throw err;
	};
	// Async 'error' events (a buffered flush fails after the reader closed).
	process.stdout.on("error", swallowEpipe);
	process.stderr.on("error", swallowEpipe);
	// Bun's synchronous write throw escapes the awaited chain and lands here.
	process.on("uncaughtException", swallowEpipe);
}
