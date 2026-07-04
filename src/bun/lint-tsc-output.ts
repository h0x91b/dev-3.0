/**
 * Pure evaluation of `tsc --noEmit` output for scripts/lint.ts.
 *
 * We own only src/ — third-party packages (e.g. electrobun) ship raw `.ts`
 * sources whose errors we must ignore, so a nonzero tsc exit alone is not a
 * failure. But a tsc run that failed WITHOUT producing per-file diagnostics
 * (corrupt tsconfig, missing binary, crash) must fail loudly instead of being
 * filtered into a green "no errors in src/".
 */

export interface TscEvaluation {
	failed: boolean;
	/** Diagnostic lines to surface when failed (may be empty for silent crashes). */
	errorLines: string[];
}

/** `path/file.ts(12,5): error TS2322: ...` — a diagnostic bound to a source file. */
const PER_FILE_DIAGNOSTIC = /\(\d+,\d+\): error TS\d+/;
/** `error TS5058: ...` — a global tsc error with no file (config missing, no inputs). */
const GLOBAL_ERROR = /^error TS\d+/;
/** `tsconfig.json(5,3): error TS1005: ...` — the config itself is broken. */
const CONFIG_ERROR = /^tsconfig[^(]*\(\d+,\d+\): error TS\d+/;

export function evaluateTscOutput(exitCode: number, combined: string): TscEvaluation {
	const lines = combined.split("\n");

	const srcErrors = lines.filter((l) => l.startsWith("src/"));
	if (srcErrors.length > 0) {
		return { failed: true, errorLines: srcErrors };
	}

	const globalErrors = lines.filter((l) => GLOBAL_ERROR.test(l) || CONFIG_ERROR.test(l));
	if (globalErrors.length > 0) {
		return { failed: true, errorLines: globalErrors };
	}

	// tsc exited nonzero without emitting any per-file diagnostics: it crashed
	// or never type-checked at all (missing binary, OOM, bunx resolution
	// failure). Surface whatever it printed instead of reporting success.
	if (exitCode !== 0 && !lines.some((l) => PER_FILE_DIAGNOSTIC.test(l))) {
		return { failed: true, errorLines: lines.filter((l) => l.trim() !== "") };
	}

	return { failed: false, errorLines: [] };
}
