/**
 * Leave the desktop process with a real exit code.
 *
 * Electrobun REPLACES `process.exit`: the first call routes into its own
 * `quit()`, which emits `before-quit` (our gate can cancel it) and then always
 * ends in `forceExit(0)` — so a desktop-side `process.exit(8)` exits 0. It does
 * not patch `process.reallyExit`, which is the Node-compat primitive underneath
 * (verified on Windows with Bun 1.3.14: `bun -e "process.reallyExit(8)"` exits 8).
 *
 * `reallyExit` skips exit handlers and any buffered stream flush, so callers must
 * have written their diagnostic synchronously (`writeSync`) before calling this.
 */

export interface ExitCapableProcess {
	exit: (code?: number) => never;
	reallyExit?: (code: number) => void;
}

export function hardExit(code: number, proc: ExitCapableProcess = process): void {
	const reallyExit = proc.reallyExit;
	if (typeof reallyExit === "function") {
		reallyExit.call(proc, code);
		return;
	}
	proc.exit(code);
}
