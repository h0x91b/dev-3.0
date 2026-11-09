/**
 * A plain-http LAN address is not a secure context, and there the browser
 * withholds `crypto.randomUUID`. `crypto.getRandomValues` exists everywhere.
 */
function uuidFromRandomValues(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	// Set version 4 and variant bits
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Generate a v4 UUID in any context. */
export function randomUUID(): string {
	return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : uuidFromRandomValues();
}

/**
 * Give `crypto.randomUUID` to a context that lacks it. Run once at boot, so a
 * direct call anywhere in the renderer — or in shared code it runs — works over
 * LAN http instead of taking the whole app down.
 */
export function installRandomUUID(): void {
	if (typeof crypto.randomUUID === "function") return;
	Object.defineProperty(crypto, "randomUUID", { value: uuidFromRandomValues, configurable: true, writable: true });
}
