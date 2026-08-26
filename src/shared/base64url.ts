export function base64UrlToBytes(value: string): Uint8Array {
	const pad = "=".repeat((4 - (value.length % 4)) % 4);
	const raw = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
