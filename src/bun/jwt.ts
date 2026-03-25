/**
 * Zero-dependency JWT module using Bun's Web Crypto API (HMAC-SHA256).
 *
 * Two token types:
 * - "qr"      — short-lived (30s), embedded in QR code URLs, single-use
 * - "session"  — long-lived (30min), used for WebSocket auth, refreshable
 */

// ── Constants ────────────────────────────────────────────────────────

const QR_TOKEN_TTL_S = 30;
const SESSION_TOKEN_TTL_S = 30 * 60; // 30 minutes

// Pre-encoded JWT header: {"alg":"HS256","typ":"JWT"}
const HEADER_B64 = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

// ── Types ────────────────────────────────────────────────────────────

export interface JwtPayload {
	type: "qr" | "session";
	iat: number; // issued at (epoch seconds)
	exp: number; // expiration (epoch seconds)
	jti: string; // unique token ID
}

// ── State ────────────────────────────────────────────────────────────

let secret: CryptoKey | null = null;

/** Set of used QR token JTIs for replay prevention. Maps jti → exp. */
const usedQrTokens = new Map<string, number>();

// ── Base64url helpers ────────────────────────────────────────────────

function base64urlEncode(data: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < data.length; i++) {
		binary += String.fromCharCode(data[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
	// Restore standard base64
	let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
	// Add padding
	while (base64.length % 4 !== 0) base64 += "=";
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function encodePayload(payload: JwtPayload): string {
	const json = JSON.stringify(payload);
	return base64urlEncode(new TextEncoder().encode(json));
}

function decodePayload(b64: string): JwtPayload | null {
	try {
		const bytes = base64urlDecode(b64);
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

// ── Core JWT operations ──────────────────────────────────────────────

/**
 * Initialize the HMAC-SHA256 signing key. Must be called once at startup.
 * Subsequent calls are no-ops.
 */
export async function initSecret(): Promise<void> {
	if (secret) return;
	const raw = crypto.getRandomValues(new Uint8Array(32));
	secret = await crypto.subtle.importKey(
		"raw",
		raw,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function signJwt(payload: JwtPayload): Promise<string> {
	if (!secret) throw new Error("JWT secret not initialized — call initSecret() first");
	const payloadB64 = encodePayload(payload);
	const data = new TextEncoder().encode(`${HEADER_B64}.${payloadB64}`);
	const sig = await crypto.subtle.sign("HMAC", secret, data);
	const sigB64 = base64urlEncode(new Uint8Array(sig));
	return `${HEADER_B64}.${payloadB64}.${sigB64}`;
}

async function verifyJwt(token: string): Promise<JwtPayload | null> {
	if (!secret) return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [header, payload, signature] = parts;
	if (header !== HEADER_B64) return null;

	try {
		const data = new TextEncoder().encode(`${header}.${payload}`);
		const sig = base64urlDecode(signature);
		const valid = await crypto.subtle.verify("HMAC", secret, sig as BufferSource, data);
		if (!valid) return null;
	} catch {
		return null;
	}

	const decoded = decodePayload(payload);
	if (!decoded) return null;

	// Check expiration
	const now = Math.floor(Date.now() / 1000);
	if (decoded.exp <= now) return null;

	return decoded;
}

// ── Cleanup ──────────────────────────────────────────────────────────

function cleanupUsedTokens(): void {
	const now = Math.floor(Date.now() / 1000);
	for (const [jti, exp] of usedQrTokens) {
		// Keep for 60s after expiration to handle clock skew
		if (exp + 60 < now) {
			usedQrTokens.delete(jti);
		}
	}
}

// ── Public API ───────────────────────────────────────────────────────

/** Create a short-lived QR token (30s). */
export async function createQrToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJwt({
		type: "qr",
		iat: now,
		exp: now + QR_TOKEN_TTL_S,
		jti: crypto.randomUUID(),
	});
}

/** Create a long-lived session token (30min). */
export async function createSessionToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJwt({
		type: "session",
		iat: now,
		exp: now + SESSION_TOKEN_TTL_S,
		jti: crypto.randomUUID(),
	});
}

/**
 * Exchange a QR token for a session token.
 * The QR token must be valid, unexpired, type "qr", and not previously used.
 * Returns session token on success, null on failure.
 */
export async function exchangeQrForSession(token: string): Promise<string | null> {
	cleanupUsedTokens();

	const payload = await verifyJwt(token);
	if (!payload) return null;
	if (payload.type !== "qr") return null;

	// Check replay
	if (usedQrTokens.has(payload.jti)) return null;
	usedQrTokens.set(payload.jti, payload.exp);

	return createSessionToken();
}

/**
 * Refresh a session token. The current token must be valid and unexpired.
 * Returns a fresh session token with a new 30-minute window.
 */
export async function refreshSession(token: string): Promise<string | null> {
	const payload = await verifyJwt(token);
	if (!payload) return null;
	if (payload.type !== "session") return null;
	return createSessionToken();
}

/**
 * Verify that a token is a valid, unexpired session token.
 */
export async function verifySessionToken(token: string): Promise<boolean> {
	const payload = await verifyJwt(token);
	if (!payload) return false;
	return payload.type === "session";
}

// ── Testing helpers ──────────────────────────────────────────────────

/** Reset module state. Only for tests. */
export function _resetForTests(): void {
	secret = null;
	usedQrTokens.clear();
}
