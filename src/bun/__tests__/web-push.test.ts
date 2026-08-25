/**
 * VAPID and aes128gcm, hand-rolled on WebCrypto.
 *
 * The interesting assertion is the decrypt round-trip. A push service returns
 * 201 without ever decrypting the payload — it cannot, that is the point of
 * RFC 8291 — so a green send proves the JWT and nothing about the ciphertext.
 * These tests decrypt with a subscription key we control, which is the only way
 * to catch a broken HKDF or a swapped nonce before a device does.
 */
import { describe, it, expect } from "vitest";
import { encryptPayload, generateVapidKeys, subscriptionIsGone, vapidAuthHeader, type PushSubscription } from "../web-push";

const b64urlToBytes = (s: string): Uint8Array => {
	const pad = "=".repeat((4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
};
const bytesToB64url = (b: Uint8Array): string =>
	btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Stand in for a browser: a real P-256 keypair plus a 16-byte auth secret. */
async function fakeDevice(): Promise<{ sub: PushSubscription; privateKey: CryptoKey; auth: Uint8Array }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		sub: {
			endpoint: "https://web.push.apple.com/example",
			keys: { p256dh: bytesToB64url(raw), auth: bytesToB64url(auth) },
		},
		privateKey: pair.privateKey,
		auth,
	};
}

/** The receiving half of RFC 8291, written independently of the sender. */
async function decrypt(body: Uint8Array, privateKey: CryptoKey, auth: Uint8Array, uaPublic: Uint8Array): Promise<string> {
	const salt = body.subarray(0, 16);
	const idlen = body[20];
	const asPublic = body.subarray(21, 21 + idlen);
	const ciphertext = body.subarray(21 + idlen);

	const asKey = await crypto.subtle.importKey("raw", asPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, privateKey, 256));

	const enc = new TextEncoder();
	const concat = (...p: Uint8Array[]) => {
		const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
		let off = 0;
		for (const x of p) {
			out.set(x, off);
			off += x.length;
		}
		return out;
	};
	const hkdf = async (ikm: Uint8Array, s: Uint8Array, info: Uint8Array, bytes: number) => {
		const k = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
		return new Uint8Array(
			await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s as BufferSource, info: info as BufferSource }, k, bytes * 8),
		);
	};

	const ikm = await hkdf(shared, auth, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
	const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, key, ciphertext as BufferSource),
	);
	// Strip the 0x02 last-record delimiter.
	return new TextDecoder().decode(plain.subarray(0, plain.length - 1));
}

describe("aes128gcm payload encryption", () => {
	it("produces something the receiving device can actually decrypt", async () => {
		const device = await fakeDevice();
		const payload = JSON.stringify({ title: "#42 Refactor the billing flow", body: "Agent has questions" });
		const body = await encryptPayload(device.sub, payload);
		const round = await decrypt(body, device.privateKey, device.auth, b64urlToBytes(device.sub.keys.p256dh));
		expect(round).toBe(payload);
	});

	it("lays the header out as RFC 8291 specifies", async () => {
		const device = await fakeDevice();
		const body = await encryptPayload(device.sub, "x");
		expect(body[20]).toBe(65); // uncompressed P-256 point length
		expect(body[21]).toBe(0x04); // and it is uncompressed
		expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
	});

	it("never repeats a salt, so two identical payloads differ on the wire", async () => {
		const device = await fakeDevice();
		const a = await encryptPayload(device.sub, "same");
		const b = await encryptPayload(device.sub, "same");
		expect(bytesToB64url(a.subarray(0, 16))).not.toBe(bytesToB64url(b.subarray(0, 16)));
	});

	it("refuses a subscription whose key is not a P-256 point", async () => {
		const device = await fakeDevice();
		const bad = { ...device.sub, keys: { ...device.sub.keys, p256dh: bytesToB64url(new Uint8Array(10)) } };
		await expect(encryptPayload(bad, "x")).rejects.toThrow();
	});
});

describe("VAPID header", () => {
	it("signs an ES256 JWT scoped to the push service, not the endpoint path", async () => {
		const keys = await generateVapidKeys();
		const header = await vapidAuthHeader("https://web.push.apple.com/some/long/path", keys, "https://example.test", 1_800_000_000);
		const [, token] = header.match(/t=([^,]+)/) ?? [];
		const [h, claims] = token.split(".");
		expect(JSON.parse(new TextDecoder().decode(b64urlToBytes(h)))).toEqual({ typ: "JWT", alg: "ES256" });
		const parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(claims)));
		expect(parsed.aud).toBe("https://web.push.apple.com");
		expect(parsed.sub).toBe("https://example.test");
		expect(parsed.exp).toBe(1_800_000_000 + 12 * 60 * 60);
	});

	it("carries the public key so the service can verify the signature", async () => {
		const keys = await generateVapidKeys();
		const header = await vapidAuthHeader("https://fcm.googleapis.com/x", keys, "https://example.test", 1_800_000_000);
		expect(header).toContain(`k=${keys.publicKey}`);
	});

	it("emits a raw r||s signature, not DER", async () => {
		const keys = await generateVapidKeys();
		const header = await vapidAuthHeader("https://fcm.googleapis.com/x", keys, "https://example.test", 1_800_000_000);
		const sig = (header.match(/t=([^,]+)/)?.[1] ?? "").split(".")[2];
		// Apple rejects a DER-wrapped signature; 64 bytes is the JWS form.
		expect(b64urlToBytes(sig).length).toBe(64);
	});

	it("generates a 65-byte uncompressed public point", async () => {
		const keys = await generateVapidKeys();
		const pub = b64urlToBytes(keys.publicKey);
		expect(pub.length).toBe(65);
		expect(pub[0]).toBe(0x04);
		expect(keys.privateKey.length).toBeGreaterThan(0);
	});
});

describe("subscription pruning", () => {
	it("treats only 404 and 410 as gone", () => {
		expect(subscriptionIsGone(404)).toBe(true);
		expect(subscriptionIsGone(410)).toBe(true);
		// A rate limit or an outage must not delete the user's device.
		expect(subscriptionIsGone(429)).toBe(false);
		expect(subscriptionIsGone(500)).toBe(false);
		expect(subscriptionIsGone(201)).toBe(false);
	});
});
