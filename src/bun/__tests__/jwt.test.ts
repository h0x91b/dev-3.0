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
	it("persists the secret as 64 hex chars with 0600 permissions; repeated calls are no-ops", async () => {
		expect(existsSync(testSecretFile)).toBe(true);
		const content = readFileSync(testSecretFile, "utf-8").trim();
		expect(content).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(testSecretFile).mode & 0o777).toBe(0o600);

		// Already called in beforeEach; calling again must not throw or rotate the secret.
		await initSecret(testSecretFile);
		await initSecret(testSecretFile);
		expect(readFileSync(testSecretFile, "utf-8").trim()).toBe(content);
		expect((await createQrToken()).split(".")).toHaveLength(3);
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
	it("returns a unique 3-part JWT of type 'qr' with a ~65s expiry", async () => {
		const token = await createQrToken();
		const parts = token.split(".");
		expect(parts).toHaveLength(3);
		for (const part of parts) {
			expect(part.length).toBeGreaterThan(0);
		}
		const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
		expect(payload.type).toBe("qr");
		expect(payload.exp - payload.iat).toBe(65);
		expect(payload.jti).toBeTruthy();
		expect(await createQrToken()).not.toBe(token);
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
	it("rejects expired QR token", async () => {
		// Create a token, then simulate expiration by advancing time
		const qrToken = await createQrToken();
		// Manually create an expired token by modifying Date.now
		const originalNow = Date.now;
		Date.now = () => originalNow() + 66_000; // 66 seconds later
		const result = await exchangeQrForSession(qrToken);
		Date.now = originalNow;
		expect(result).toBeNull();
	});

	it("exchanges each QR token for a valid session exactly once (no replay)", async () => {
		const qr1 = await createQrToken();
		const qr2 = await createQrToken();
		const qr3 = await createQrToken();

		const session = await exchangeQrForSession(qr1);
		expect(session).toBeTruthy();
		expect(await verifySessionToken(session!)).toBe(true);
		// Replay qr1 — should fail
		expect(await exchangeQrForSession(qr1)).toBeNull();

		// qr2 is still valid (different token)
		expect(await exchangeQrForSession(qr2)).toBeTruthy();
		expect(await exchangeQrForSession(qr2)).toBeNull();

		// qr3 still valid
		expect(await exchangeQrForSession(qr3)).toBeTruthy();
	});

	it("rejects a session token (wrong type) and garbage input", async () => {
		expect(await exchangeQrForSession(await createSessionToken())).toBeNull();
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

	it("rejects an expired session token and a QR token (wrong type)", async () => {
		const session = await createSessionToken();
		const qrToken = await createQrToken();
		const originalNow = Date.now;
		Date.now = () => originalNow() + (24 * 60 + 1) * 60 * 1000; // just past the 24h TTL
		const result = await refreshSession(session);
		Date.now = originalNow;
		expect(result).toBeNull();
		expect(await refreshSession(qrToken)).toBeNull();
	});
});

// ================================================================
// verifySessionToken
// ================================================================

describe("verifySessionToken", () => {
	it("returns false for a QR token and for garbage", async () => {
		expect(await verifySessionToken(await createQrToken())).toBe(false);
		expect(await verifySessionToken("garbage")).toBe(false);
		expect(await verifySessionToken("")).toBe(false);
	});

	it("returns false for expired session token", async () => {
		const token = await createSessionToken();
		const originalNow = Date.now;
		Date.now = () => originalNow() + (24 * 60 + 1) * 60 * 1000; // just past the 24h TTL
		expect(await verifySessionToken(token)).toBe(false);
		Date.now = originalNow;
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
