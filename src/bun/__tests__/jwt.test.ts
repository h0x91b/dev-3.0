import { describe, it, expect, beforeEach } from "vitest";
import {
	initSecret,
	createQrToken,
	createSessionToken,
	exchangeQrForSession,
	refreshSession,
	verifySessionToken,
	_resetForTests,
} from "../jwt";

beforeEach(async () => {
	_resetForTests();
	await initSecret();
});

// ================================================================
// initSecret
// ================================================================

describe("initSecret", () => {
	it("can be called multiple times (subsequent calls are no-ops)", async () => {
		// Already called in beforeEach; calling again should not throw
		await initSecret();
		await initSecret();
		// Tokens should still work after multiple init calls
		const token = await createQrToken();
		expect(token.split(".")).toHaveLength(3);
	});
});

// ================================================================
// createQrToken
// ================================================================

describe("createQrToken", () => {
	it("returns a valid JWT string with 3 parts", async () => {
		const token = await createQrToken();
		const parts = token.split(".");
		expect(parts).toHaveLength(3);
		// Each part should be non-empty base64url
		for (const part of parts) {
			expect(part.length).toBeGreaterThan(0);
		}
	});

	it("creates tokens with type 'qr' and ~30s expiry", async () => {
		const token = await createQrToken();
		// Decode the payload (middle part) to inspect
		const payloadB64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
		expect(payload.type).toBe("qr");
		expect(payload.exp - payload.iat).toBe(30);
		expect(payload.jti).toBeTruthy();
	});

	it("creates unique tokens each time", async () => {
		const t1 = await createQrToken();
		const t2 = await createQrToken();
		expect(t1).not.toBe(t2);
	});
});

// ================================================================
// createSessionToken
// ================================================================

describe("createSessionToken", () => {
	it("creates tokens with type 'session' and ~30min expiry", async () => {
		const token = await createSessionToken();
		const payloadB64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
		expect(payload.type).toBe("session");
		expect(payload.exp - payload.iat).toBe(30 * 60);
	});
});

// ================================================================
// exchangeQrForSession
// ================================================================

describe("exchangeQrForSession", () => {
	it("exchanges valid QR token for session token", async () => {
		const qrToken = await createQrToken();
		const sessionToken = await exchangeQrForSession(qrToken);
		expect(sessionToken).toBeTruthy();
		// Verify the returned token is a session token
		const valid = await verifySessionToken(sessionToken!);
		expect(valid).toBe(true);
	});

	it("rejects expired QR token", async () => {
		// Create a token, then simulate expiration by advancing time
		const qrToken = await createQrToken();
		// Manually create an expired token by modifying Date.now
		const originalNow = Date.now;
		Date.now = () => originalNow() + 31_000; // 31 seconds later
		const result = await exchangeQrForSession(qrToken);
		Date.now = originalNow;
		expect(result).toBeNull();
	});

	it("prevents replay (same token used twice)", async () => {
		const qrToken = await createQrToken();
		const first = await exchangeQrForSession(qrToken);
		expect(first).toBeTruthy();
		const second = await exchangeQrForSession(qrToken);
		expect(second).toBeNull();
	});

	it("rejects session token (wrong type)", async () => {
		const sessionToken = await createSessionToken();
		const result = await exchangeQrForSession(sessionToken);
		expect(result).toBeNull();
	});

	it("rejects garbage input", async () => {
		expect(await exchangeQrForSession("not.a.jwt")).toBeNull();
		expect(await exchangeQrForSession("")).toBeNull();
		expect(await exchangeQrForSession("abc")).toBeNull();
	});
});

// ================================================================
// refreshSession
// ================================================================

describe("refreshSession", () => {
	it("refreshes valid session token", async () => {
		const session = await createSessionToken();
		const refreshed = await refreshSession(session);
		expect(refreshed).toBeTruthy();
		expect(refreshed).not.toBe(session); // Different token (new jti/iat)
		const valid = await verifySessionToken(refreshed!);
		expect(valid).toBe(true);
	});

	it("rejects expired session token", async () => {
		const session = await createSessionToken();
		const originalNow = Date.now;
		Date.now = () => originalNow() + 31 * 60 * 1000; // 31 minutes later
		const result = await refreshSession(session);
		Date.now = originalNow;
		expect(result).toBeNull();
	});

	it("rejects QR token (wrong type)", async () => {
		const qrToken = await createQrToken();
		const result = await refreshSession(qrToken);
		expect(result).toBeNull();
	});
});

// ================================================================
// verifySessionToken
// ================================================================

describe("verifySessionToken", () => {
	it("returns true for valid session token", async () => {
		const token = await createSessionToken();
		expect(await verifySessionToken(token)).toBe(true);
	});

	it("returns false for QR token", async () => {
		const token = await createQrToken();
		expect(await verifySessionToken(token)).toBe(false);
	});

	it("returns false for expired session token", async () => {
		const token = await createSessionToken();
		const originalNow = Date.now;
		Date.now = () => originalNow() + 31 * 60 * 1000;
		expect(await verifySessionToken(token)).toBe(false);
		Date.now = originalNow;
	});

	it("returns false for garbage", async () => {
		expect(await verifySessionToken("garbage")).toBe(false);
		expect(await verifySessionToken("")).toBe(false);
	});

	it("returns false for tampered token", async () => {
		const token = await createSessionToken();
		// Tamper with the payload
		const parts = token.split(".");
		const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
		expect(await verifySessionToken(tampered)).toBe(false);
	});

	it("returns false when secret not initialized", async () => {
		const token = await createSessionToken();
		_resetForTests(); // Clear the secret
		expect(await verifySessionToken(token)).toBe(false);
	});
});
