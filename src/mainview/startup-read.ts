import { recordDiagnostic } from "./diagnostics";

/**
 * A read the UI starts on mount and otherwise sits on a placeholder without.
 *
 * A lost request never settles — it only fails after the transport's 6-minute
 * cap — so each attempt races its own timeout, and a failed or silent attempt
 * is logged and retried instead of swallowed. The last failure still rejects,
 * so a caller that has an error state can show it.
 */
export interface StartupReadOptions {
	/** Per-attempt wait before the attempt counts as lost. */
	attemptTimeoutMs?: number;
	/** Delays before each retry; its length is the number of retries. */
	retryDelaysMs?: readonly number[];
	/** Stops further attempts, e.g. once the component unmounted. */
	isCancelled?: () => boolean;
	setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
}

export const STARTUP_READ_ATTEMPT_TIMEOUT_MS = 10_000;
export const STARTUP_READ_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000];

export class StartupReadCancelled extends Error {
	constructor(label: string) {
		super(`Startup read "${label}" cancelled`);
		this.name = "StartupReadCancelled";
	}
}

export async function startupRead<T>(
	label: string,
	read: () => Promise<T>,
	opts: StartupReadOptions = {},
): Promise<T> {
	const attemptTimeoutMs = opts.attemptTimeoutMs ?? STARTUP_READ_ATTEMPT_TIMEOUT_MS;
	const retryDelays = opts.retryDelaysMs ?? STARTUP_READ_RETRY_DELAYS_MS;
	const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimeoutFn = opts.clearTimeoutFn ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	const wait = (ms: number) => new Promise<void>((resolve) => { setTimeoutFn(resolve, ms); });

	for (let attempt = 0; ; attempt++) {
		if (opts.isCancelled?.()) throw new StartupReadCancelled(label);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				read(),
				new Promise<never>((_, reject) => {
					timer = setTimeoutFn(
						() => reject(new Error(`no answer within ${attemptTimeoutMs} ms`)),
						attemptTimeoutMs,
					);
				}),
			]);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const finalAttempt = attempt >= retryDelays.length;
			console.warn(`[startup-read] ${label} failed (attempt ${attempt + 1}): ${message}`);
			recordDiagnostic({
				kind: "rpc",
				level: finalAttempt ? "error" : "warn",
				message: finalAttempt
					? `Could not load ${label} — the app is showing defaults`
					: `Loading ${label} failed, retrying`,
				detail: message,
				source: label,
			});
			if (finalAttempt) throw err;
			await wait(retryDelays[attempt]);
		} finally {
			if (timer !== undefined) clearTimeoutFn(timer);
		}
	}
}

/** For callers with no error UI: the failure is already logged, nothing to rethrow. */
export function ignoreStartupReadFailure(): void {}
