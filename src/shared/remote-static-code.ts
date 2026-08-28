/**
 * Validation shared by every entry point that can set a remote-access static
 * code: the `dev3 remote` flag parser, the systemd unit writer, and the
 * server's own startup check on DEV3_REMOTE_STATIC_CODE.
 *
 * The code is a long-lived, multi-use bearer credential fronting full terminal
 * access — reuse is the feature — so its length is the entire search space an
 * attacker has to cover. `/auth/exchange` throttles guesses; the length is what
 * makes throttled guessing hopeless rather than merely slow.
 */

export const MIN_REMOTE_STATIC_CODE_LENGTH = 8;

/**
 * Human-readable reason the code is unusable, or null when it is fine.
 * Reports the length rather than echoing the code — the same message is written
 * to the server log, which the code itself must never reach.
 */
export function remoteStaticCodeError(code: string): string | null {
	if (code.length < MIN_REMOTE_STATIC_CODE_LENGTH) {
		return `must be at least ${MIN_REMOTE_STATIC_CODE_LENGTH} characters (got ${code.length})`;
	}
	return null;
}
