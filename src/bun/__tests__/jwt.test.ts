import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	initSecret,
	createQrToken,
	createSessionToken,
	exchangeQrForSession,
	refreshSession,
	verifySessionToken,
	_resetForTests,
} from "../jwt";

// Always point initSecret at a temp file — the default path is the user's
// real ~/.dev3.0/remote-jwt-secret and tests must never touch it.
const testSecretDir = join(tmpdir(), `dev3-jwt-test-${process.pid}`);
const testSecretFile = join(testSecretDir, "remote-jwt-secret");

beforeEach(async () => {
	_resetForTests();
	rmSync(testSecretDir, { recursive: true, force: true });
	await initSecret(testSecretFile);
});

afterAll(() => {
	rmSync(testSecretDir, { recursive: true, force: true });
});

// ================================================================
// initSecret
// ================================================================

describe("initSecret", () => {
	it("can be called multiple times (subsequent calls are no-ops)", async () => {
		// Already called in beforeEach; calling again should not throw
		await initSecret(testSecretFile);
		await initSecret(testSecretFile);
		// Tokens should still work after multiple init calls
		const token = await createQrToken();
		expect(token.split(".")).toHaveLength(3);
	});

	it("persists the secret to disk as 64 hex chars with 0600 permissions", () => {
		expect(existsSync(testSecretFile)).toBe(true);
		const content = readFileSync(testSecretFile, "utf-8").trim();
		expect(content).toMatch(/^[0-9a-f]{64}$/);
		const mode = statSync(testSecretFile).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("session tokens survive a restart (secret reloaded from disk)", async () => {
		const session = await createSessionToken();
		// Simulate an app restart: wipe in-memory state, re-init from the same file.
		_resetForTests();
		await initSecret(testSecretFile);
		expect(await verifySessionToken(session)).toBe(true);
	});

	it("a different secret file yields a different secret (tokens rejected)", async () => {
		const session = await createSessionToken();
		_resetForTests();
		await initSecret(join(testSecretDir, "other-secret"));
		expect(await verifySessionToken(session)).toBe(false);
	});

	it("regenerates and overwrites a corrupt secret file", async () => {
		_resetForTests();
		writeFileSync(testSecretFile, "not-hex-garbage\n");
		await initSecret(testSecretFile);
		const content = readFileSync(testSecretFile, "utf-8").trim();
		expect(content).toMatch(/^[0-9a-f]{64}$/);
		// The regenerated secret works end-to-end.
		const session = await createSessionToken();
		expect(await verifySessionToken(session)).toBe(true);
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
	it("creates tokens with type 'session' and a 24h expiry", async () => {
		const token = await createSessionToken();
		const payloadB64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
		expect(payload.type).toBe("session");
		expect(payload.exp - payload.iat).toBe(24 * 60 * 60);
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

	it("each QR token is independently single-use", async () => {
		const qr1 = await createQrToken();
		const qr2 = await createQrToken();
		const qr3 = await createQrToken();

		// Exchange qr1 — should succeed
		expect(await exchangeQrForSession(qr1)).toBeTruthy();
		// Replay qr1 — should fail
		expect(await exchangeQrForSession(qr1)).toBeNull();

		// qr2 is still valid (different token)
		expect(await exchangeQrForSession(qr2)).toBeTruthy();
		// Replay qr2 — should fail
		expect(await exchangeQrForSession(qr2)).toBeNull();

		// qr3 still valid
		expect(await exchangeQrForSession(qr3)).toBeTruthy();
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
		Date.now = () => originalNow() + (24 * 60 + 1) * 60 * 1000; // just past the 24h TTL
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
		Date.now = () => originalNow() + (24 * 60 + 1) * 60 * 1000; // just past the 24h TTL
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
