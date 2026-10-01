/**
 * Validation for the remote-access listen address (`dev3 remote --host`,
 * DEV3_REMOTE_HOST). Pure, so the CLI and the server share one rule.
 */

/** Why `value` cannot be a listen host, or null when it can. Shared with the CLI's `--host`. */
export function listenHostError(value: string): string | null {
	if (value === "localhost") return null;
	const parts = value.split(".");
	const ipv4 = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
	return ipv4 ? null : `must be an IPv4 address or "localhost" (got "${value}")`;
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
