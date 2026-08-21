/** Interactive-shell probe helpers for the native-session lifecycle E2E. */

interface SendUntilObservedOptions<T> {
	send: () => void;
	observe: () => T | null;
	attempts: number;
	attemptTimeoutMs: number;
	pollIntervalMs: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function powerShellRootStateProbe(
	state: string,
	shellPid: number,
): { command: string; observe: (text: string) => string | null } {
	const expected = `ROOTSTATE[${state}][${shellPid}]`;
	return {
		command: `$env:DEV3_NATIVE_STATE='${state}'; Write-Output "ROOTSTATE[$env:DEV3_NATIVE_STATE][$PID]"`,
		observe: (text) => (text.includes(expected) ? expected : null),
	};
}

export function powerShellReattachStateProbe(
	state: string,
	shellPid: number,
): { command: string; observe: (text: string) => string | null } {
	const expected = `MARKER[${state}][${shellPid}]`;
	return {
		command: 'Write-Output "MARKER[$env:DEV3_NATIVE_STATE][$PID]"',
		observe: (text) => (text.includes(expected) ? expected : null),
	};
}

/**
 * Retry budget for probing a FRESHLY started interactive shell — the one shared
 * knob for every warm-up probe.
 *
 * A cold CI runner (Windows especially: PowerShell's first interactive prompt)
 * can take well over the ~4s the call sites used to allow, and the probe would
 * give up moments before the shell answered — the observed flake was two failed
 * checks immediately followed by a successful wait on the NEXT command's output.
 * The budget is a ceiling, not a delay: `sendUntilObserved` returns as soon as
 * the probe is observed.
 */
export const SHELL_WARMUP_PROBE = { attempts: 15, attemptTimeoutMs: 2000, pollIntervalMs: 30 } as const;

/**
 * Budget for awaiting the output of a command that must NOT be re-sent (it has
 * side effects, e.g. spawning a process). Hence a single long wait instead of
 * retries — same cold-runner patience, no duplicate side effects.
 */
export const SINGLE_SHOT_WAIT = { attempts: 1, attemptTimeoutMs: 20_000, pollIntervalMs: 30 } as const;

/**
 * Lines that take one Windows session's line editor out of the conversation
 * between sessions, typed before any marker.
 *
 * PSReadLine keeps ONE history file per Windows user — resolved through the shell
 * API, so no environment variable can split it — and predicts from it as soon as a
 * line is typed. A second session that loaded after the first accepted a line
 * therefore renders the FIRST session's whole command as dim ghost text into its own
 * PTY, which lands in its own journal and looks exactly like cross-session leakage
 * (proved on windows-latest: 11 of 12 with no dev3 in the picture; see
 * cross-session-echo-probe.ts). Two separate commands on purpose: PredictionSource
 * exists only in PSReadLine 2.1+, and an unknown parameter must not take the other
 * setting down with it.
 */
export const WINDOWS_LINE_EDITOR_QUIET = [
	"Set-PSReadLineOption -HistorySaveStyle SaveNothing",
	"Set-PSReadLineOption -PredictionSource None",
] as const;

/** Retry an idempotent probe while a new interactive shell prompt starts. */
export async function sendUntilObserved<T>(options: SendUntilObservedOptions<T>): Promise<T | null> {
	for (let attempt = 0; attempt < options.attempts; attempt++) {
		options.send();
		const deadline = Date.now() + options.attemptTimeoutMs;
		do {
			const observed = options.observe();
			if (observed !== null) return observed;
			await delay(options.pollIntervalMs);
		} while (Date.now() <= deadline);
	}
	return null;
}
