/**
 * Validation for the remote-access listen address (`dev3 remote --host`,
 * DEV3_REMOTE_HOST). Pure, so the CLI and the server share one rule.
 */

/** The bind addresses `--host` accepts: every interface, or this machine only.
 *  A specific LAN address is refused: the tunnel dials `localhost`, which it would not reach. */
export const LISTEN_HOSTS = ["0.0.0.0", "127.0.0.1", "localhost"] as const;

/** Why `value` cannot be a listen host, or null when it can. Shared with the CLI's `--host`. */
export function listenHostError(value: string): string | null {
	return (LISTEN_HOSTS as readonly string[]).includes(value)
		? null
		: `must be 127.0.0.1, localhost or 0.0.0.0 (got "${value}")`;
}

/**
 * Whether a phone could open `url`, so a QR of it is worth printing. A loopback
 * bind (or a machine with no LAN address) yields a `localhost` access URL; a
 * tunnel URL stays scannable whatever the bind.
 */
export function isScannableAccessUrl(url: string): boolean {
	const host = new URL(url).hostname;
	return host !== "localhost" && !host.startsWith("127.");
}
