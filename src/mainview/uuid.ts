/**
 * Generate a v4 UUID. Uses crypto.randomUUID() when available (secure context),
 * falls back to crypto.getRandomValues() which works in all contexts.
 */
export function randomUUID(): string {
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Fallback for non-secure contexts (HTTP on LAN)
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	// Set version 4 and variant bits
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
