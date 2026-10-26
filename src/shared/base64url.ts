export function base64UrlToBytes(value: string): Uint8Array {
	const pad = "=".repeat((4 - (value.length % 4)) % 4);
	const raw = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	let raw = "";
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
