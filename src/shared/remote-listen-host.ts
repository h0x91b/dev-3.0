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
