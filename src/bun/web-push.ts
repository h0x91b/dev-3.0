/**
 * Web Push: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), on
 * WebCrypto alone.
 *
 * No dependency, for the same reason src/bun/jwt.ts hand-rolls its session JWT:
 * npm `web-push` pulls 17 transitive packages to do what crypto.subtle already
 * does. Validated against both live services — see
 * decisions/2026/08/26/web-push-without-the-dependency.md.
 *
 * Nothing here reaches a vendor of ours. The push services relay ciphertext they
 * cannot read; only the subscribed device holds the keys.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { base64UrlToBytes } from "../shared/base64url";

const log = createLogger("web-push");
const enc = new TextEncoder();

export const VAPID_FILE = `${DEV3_HOME}/web-push-keys.json`;

export type VapidKeys = { publicKey: string; privateKey: string };
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushResult = { statusCode: number; body?: string };

/** The subject a push service can contact about this sender. An https URI naming
 *  the software, never a user's address — it travels to a third party. */
export const VAPID_SUBJECT = "https://github.com/h0x91b/dev-3.0";

function bytesToB64url(b: Uint8Array): string {
	return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/** WebCrypto's HKDF is extract+expand in one call, which is the shape RFC 8291
 *  uses at both of its stages. */
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
		key,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return { publicKey: bytesToB64url(raw), privateKey: jwk.d ?? "" };
}

function readVapidFile(path: string): VapidKeys | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as VapidKeys;
		if (parsed?.publicKey && parsed?.privateKey) return parsed;
		log.warn("Ignoring malformed VAPID key file", { path });
	} catch (err) {
		log.warn("Could not read VAPID keys", { path, error: String(err) });
	}
	return null;
}

/** One in-flight creation per path, so concurrent callers in this process cannot
 *  each mint a keypair and hand out the ones that never reached disk. */
const creating = new Map<string, Promise<VapidKeys>>();

async function readOrCreateVapidKeys(path: string): Promise<VapidKeys> {
	const existing = readVapidFile(path);
	if (existing) return existing;

	const keys = await generateVapidKeys();
	try {
		mkdirSync(dirname(path), { recursive: true });
		// "wx" fails instead of overwriting, so another process that generated keys
		// in parallel loses the write rather than orphaning the subscriptions the
		// winner has already issued.
		writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		return keys;
	} catch (err) {
		const winner = readVapidFile(path);
		if (winner) return winner;
		log.warn("Could not persist VAPID keys", { path, error: String(err) });
		throw new Error("Could not persist VAPID keys");
	}
}

/**
 * Load the install's keypair, generating it once. Rotating it invalidates every
 * existing subscription, so whatever reaches disk first is what every caller
 * gets back — a browser must never subscribe with a key nobody kept.
 */
export function loadOrCreateVapidKeys(path: string = VAPID_FILE): Promise<VapidKeys> {
	let run = creating.get(path);
	if (!run) {
		run = readOrCreateVapidKeys(path);
		creating.set(path, run);
		void run.catch(() => {}).finally(() => creating.delete(path));
	}
	return run;
}

function vapidJwk(keys: VapidKeys): JsonWebKey {
	const pub = base64UrlToBytes(keys.publicKey);
	if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
	return {
		kty: "EC",
		crv: "P-256",
		x: bytesToB64url(pub.subarray(1, 33)),
		y: bytesToB64url(pub.subarray(33, 65)),
		d: keys.privateKey,
		ext: true,
	};
}

/** RFC 8292: an ES256 JWT proving who is asking the service to deliver. */
export async function vapidAuthHeader(endpoint: string, keys: VapidKeys, subject: string, nowSeconds: number): Promise<string> {
	const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = bytesToB64url(
		enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 60 * 60, sub: subject })),
	);
	const signingInput = `${header}.${claims}`;
	const key = await crypto.subtle.importKey("jwk", vapidJwk(keys), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	// crypto.subtle returns the raw r||s pair, which is already the JWS encoding —
	// no DER unwrapping, unlike the node:crypto path most implementations take.
	const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)));
	return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${keys.publicKey}`;
}

/**
 * RFC 8291 aes128gcm. The body carries its own salt and the sender's public key,
 * so the device needs only its own subscription keys to decrypt.
 */
export async function encryptPayload(sub: PushSubscription, plaintext: string, salt?: Uint8Array): Promise<Uint8Array> {
	const uaPublic = base64UrlToBytes(sub.keys.p256dh);
	const authSecret = base64UrlToBytes(sub.keys.auth);

	const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
	const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));

	// Both public keys are bound into the info, so a swapped key cannot produce
	// the same IKM.
	const ikm = await hkdf(shared, authSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);

	const realSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(ikm, realSalt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, realSalt, enc.encode("Content-Encoding: nonce\0"), 12);

	const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
	// 0x02 is the last-record delimiter; one record carries the whole payload.
	const padded = concat(enc.encode(plaintext), new Uint8Array([0x02]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, aesKey, padded as BufferSource),
	);

	const recordSize = new Uint8Array(4);
	new DataView(recordSize.buffer).setUint32(0, 4096, false);
	return concat(realSalt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

export async function sendNotification(
	sub: PushSubscription,
	payload: string,
	keys: VapidKeys,
	opts: { ttl?: number; timeoutMs?: number; now?: number; subject?: string } = {},
): Promise<PushResult> {
	const body = await encryptPayload(sub, payload);
	const auth = await vapidAuthHeader(sub.endpoint, keys, opts.subject ?? VAPID_SUBJECT, opts.now ?? Math.floor(Date.now() / 1000));
	const res = await fetch(sub.endpoint, {
		method: "POST",
		headers: {
			authorization: auth,
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(opts.ttl ?? 60),
		},
		body: body as BodyInit,
		signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
	});
	return { statusCode: res.status, ...(res.ok ? {} : { body: await res.text().catch(() => "") }) };
}

/** 404/410 mean the device dropped the subscription; anything else is transient. */
export function subscriptionIsGone(status: number): boolean {
	return status === 404 || status === 410;
}
