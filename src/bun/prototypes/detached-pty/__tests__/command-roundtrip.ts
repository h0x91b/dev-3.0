interface SendUntilObservedOptions<T> {
	send: () => void;
	observe: () => T | null;
	attempts: number;
	attemptTimeoutMs: number;
	pollIntervalMs: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function powerShellRootStateProbe(state: string, shellPid: number): {
	command: string;
	observe: (text: string) => string | null;
} {
	const expected = `ROOTSTATE[${state}][${shellPid}]`;
	return {
		command: `$env:PROTO_STATE='${state}'; Write-Output "ROOTSTATE[$env:PROTO_STATE][$PID]"`,
		observe: (text) => (text.includes(expected) ? expected : null),
	};
}

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
