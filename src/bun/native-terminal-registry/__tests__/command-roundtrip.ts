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
