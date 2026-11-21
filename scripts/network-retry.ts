/**
 * Retry policy for build steps that fail only because the network did.
 *
 * GitHub release downloads and Apple's notary/stapler endpoints drop connections often enough to
 * redden a third of all Canary runs, and re-running a whole canary costs ~30 minutes. A failure is
 * retried ONLY when its output names a network error; anything else fails on the first attempt.
 * See `decisions/2026/11/21/retry-electrobun-build-on-network-failures.md`.
 */

export const NETWORK_RETRY_ATTEMPTS = 5;
export const NETWORK_RETRY_DELAY_MS = 30_000;

/** Each pattern is a line seen in a real red Canary run; none of them can come from our own code. */
const NETWORK_FAILURES: RegExp[] = [
	/Download failed: 5\d\d/, // electrobun CLI download
	/Failed to download binaries: 5\d\d/, // electrobun core binaries
	/Failed to set up custom Bun [^\n]*HTTP 5\d\d/,
	/Gateway Time-?out/i,
	/The socket connection was closed unexpectedly/,
	/\bECONNRESET\b/,
	/NSURLErrorDomain Code=-100[15]\b/, // stapler / notarytool: request timed out, connection lost
	/The network connection was lost/,
	/\bHTTP 50[0234]\b/, // gh release upload: "HTTP 502: Server Error"
];

/** The first output line that proves the failure was the network's, or null. */
export function networkFailureIn(output: string): string | null {
	for (const line of output.split(/\r?\n/)) {
		if (NETWORK_FAILURES.some((pattern) => pattern.test(line))) return line.trim();
	}
	return null;
}

export interface AttemptResult {
	exitCode: number;
	/** The tail of what the attempt printed, enough to hold its final error. */
	output: string;
}

export interface RetryHooks {
	sleep: (ms: number) => Promise<void>;
	warn: (message: string) => void;
	attempts?: number;
	delayMs?: number;
}

/** Runs `attempt` until it succeeds, fails for a non-network reason, or the attempts run out. */
export async function retryOnNetworkFailure(
	label: string,
	attempt: (n: number) => Promise<AttemptResult>,
	{ sleep, warn, attempts = NETWORK_RETRY_ATTEMPTS, delayMs = NETWORK_RETRY_DELAY_MS }: RetryHooks,
): Promise<number> {
	for (let n = 1; ; n += 1) {
		const result = await attempt(n);
		if (result.exitCode === 0) return 0;
		const cause = networkFailureIn(result.output);
		if (!cause || n >= attempts) {
			if (cause) warn(`${label}: network failure persisted through ${attempts} attempts — giving up: ${cause}`);
			return result.exitCode;
		}
		warn(`${label}: attempt ${n}/${attempts} failed on the network (${cause}); retrying in ${delayMs / 1000}s`);
		await sleep(delayMs);
	}
}

/** `::warning::` makes a retry visible on the run summary instead of buried in the log. */
export function ciWarning(message: string, env: Record<string, string | undefined> = process.env): string {
	return env.GITHUB_ACTIONS === "true" ? `::warning title=Network retry::${message}` : `[network-retry] ${message}`;
}

export interface FetchRetryHooks extends Partial<RetryHooks> {
	fetchImpl?: (url: string) => Promise<Response>;
}

/**
 * `fetch` that retries when there was no answer at all (a reset or dropped socket) or the server
 * answered 5xx. Any other answer, a 404 included, is returned as is for the caller to judge.
 */
export async function fetchWithNetworkRetry(url: string, hooks: FetchRetryHooks = {}): Promise<Response> {
	const {
		fetchImpl = (target) => fetch(target),
		sleep = (ms) => Bun.sleep(ms),
		warn = (message) => console.log(ciWarning(message)),
		attempts = NETWORK_RETRY_ATTEMPTS,
		delayMs = NETWORK_RETRY_DELAY_MS,
	} = hooks;
	for (let n = 1; ; n += 1) {
		let cause: string;
		try {
			const response = await fetchImpl(url);
			if (response.status < 500 || n >= attempts) return response;
			cause = `HTTP ${response.status}`;
		} catch (error) {
			if (n >= attempts) throw error;
			cause = error instanceof Error ? error.message : String(error);
		}
		warn(`${url}: attempt ${n}/${attempts} failed on the network (${cause}); retrying in ${delayMs / 1000}s`);
		await sleep(delayMs);
	}
}
