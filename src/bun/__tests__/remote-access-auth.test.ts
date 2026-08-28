/**
 * Handler-level tests for the cookie-based remote auth flow (decision 132).
 *
 * Unlike remote-access-server.test.ts, this file does NOT mock ../jwt — the
 * exchange/refresh handlers run against the real JWT module with a temp-dir
 * secret file, so cookie issuance, validation, and restart survival are
 * exercised end-to-end at the Request/Response seam.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/nonexistent-views" },
	Utils: {},
	Updater: {
		localInfo: {
			version: vi.fn().mockResolvedValue("0.0.0-test"),
			hash: vi.fn().mockResolvedValue("deadbeef"),
			channel: vi.fn().mockResolvedValue("dev"),
		},
	},
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../cloudflare-tunnel", () => ({
	getTunnelUrl: vi.fn().mockReturnValue(null),
	getTunnelState: vi.fn().mockReturnValue("stopped"),
	tunnelManager: { list: vi.fn().mockReturnValue([]) },
}));

// checkOrigin honors X-Forwarded-Host only under a custom tunnel provider;
// tests flip this instead of the settings file on disk.
const tunnelProviderMocks = vi.hoisted(() => ({
	customActive: { value: false },
}));

vi.mock("../tunnel-provider", () => ({
	isCustomTunnelProviderActive: () => tunnelProviderMocks.customActive.value,
}));

const settingsMocks = vi.hoisted(() => ({
	settings: { value: { theme: "light", resolvedTheme: "light" } as Record<string, unknown> },
}));

vi.mock("../settings", () => ({
	loadSettingsSync: vi.fn(() => settingsMocks.settings.value),
}));

vi.mock("../theme-state", () => ({
	getCurrentUiTheme: vi.fn(() => "dark"),
}));

vi.mock("qrcode", () => ({
	default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,test") },
}));

import {
	SESSION_COOKIE_NAME,
	parseCookies,
	buildSessionCookie,
	buildClearSessionCookie,
	checkOrigin,
	handleAuthExchange,
	handleAuthRefresh,
	assertStaticCodeStrongEnough,
	getStaticCode,
	resetWeakSettingsCodeWarning,
} from "../remote-access-server";
import { initSecret, createQrToken, _resetForTests } from "../jwt";
import { AUTH_FAILURE_LIMIT, _resetAuthRateLimitForTests } from "../remote-auth-rate-limit";
import { MIN_REMOTE_STATIC_CODE_LENGTH } from "../../shared/remote-static-code";

const testSecretDir = join(tmpdir(), `dev3-remote-auth-test-${process.pid}`);
const testSecretFile = join(testSecretDir, "remote-jwt-secret");

beforeEach(async () => {
	delete process.env.DEV3_REMOTE_STATIC_CODE;
	// Failed exchanges are throttled per key; without this reset the accumulated
	// 401s from earlier tests in this file would 429 the later ones.
	_resetAuthRateLimitForTests();
	_resetForTests();
	rmSync(testSecretDir, { recursive: true, force: true });
	await initSecret(testSecretFile);
});

afterAll(() => {
	rmSync(testSecretDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────

function exchangeRequest(token: string, headers: Record<string, string> = {}): Request {
	return new Request("http://192.168.1.10:4242/auth/exchange", {
		method: "POST",
		headers: { "Content-Type": "application/json", host: "192.168.1.10:4242", ...headers },
		body: JSON.stringify({ token }),
	});
}

function refreshRequest(cookie?: string, headers: Record<string, string> = {}): Request {
	return new Request("http://192.168.1.10:4242/auth/refresh", {
		method: "POST",
		headers: {
			host: "192.168.1.10:4242",
			...(cookie ? { cookie } : {}),
			...headers,
		},
	});
}

/** Extract the session token value from a Set-Cookie header. */
function cookieValue(setCookie: string | null): string | null {
	if (!setCookie) return null;
	const match = setCookie.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]*)`));
	return match ? match[1] : null;
}

// ── parseCookies ─────────────────────────────────────────────────────

describe("parseCookies", () => {
	it("returns empty record for null/empty header", () => {
		expect(parseCookies(null)).toEqual({});
		expect(parseCookies("")).toEqual({});
	});

	it("parses a single cookie", () => {
		expect(parseCookies("dev3_session=abc.def.ghi")).toEqual({ dev3_session: "abc.def.ghi" });
	});

	it("parses multiple cookies and trims whitespace", () => {
		expect(parseCookies("foo=1; dev3_session=tok; bar=2")).toEqual({
			foo: "1",
			dev3_session: "tok",
			bar: "2",
		});
	});

	it("ignores malformed fragments without '='", () => {
		expect(parseCookies("garbage; dev3_session=tok")).toEqual({ dev3_session: "tok" });
	});
});

// ── Cookie builders ──────────────────────────────────────────────────

describe("session cookie builders", () => {
	it("buildSessionCookie sets HttpOnly, SameSite=Strict, Path=/ and a 24h Max-Age", () => {
		const cookie = buildSessionCookie("tok123");
		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok123`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain(`Max-Age=${24 * 60 * 60}`);
		// LAN mode is plain http — the Secure flag must NOT be present.
		expect(cookie).not.toContain("Secure");
	});

	it("buildClearSessionCookie expires the cookie immediately", () => {
		const cookie = buildClearSessionCookie();
		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
		expect(cookie).toContain("Max-Age=0");
	});
});

// ── checkOrigin ──────────────────────────────────────────────────────

describe("checkOrigin", () => {
	function reqWith(headers: Record<string, string>): Request {
		return new Request("http://10.0.0.5:4242/rpc", { headers });
	}

	it("allows a matching same-origin request", () => {
		expect(checkOrigin(reqWith({ host: "10.0.0.5:4242", origin: "http://10.0.0.5:4242" }))).toBe(true);
	});

	it("allows a matching https tunnel origin (scheme ignored, authority compared)", () => {
		expect(checkOrigin(reqWith({ host: "foo.trycloudflare.com", origin: "https://foo.trycloudflare.com" }))).toBe(true);
	});

	it("rejects a foreign origin (CSWSH)", () => {
		expect(checkOrigin(reqWith({ host: "10.0.0.5:4242", origin: "http://evil.example.com" }))).toBe(false);
	});

	it("rejects a same-host different-port origin", () => {
		expect(checkOrigin(reqWith({ host: "10.0.0.5:4242", origin: "http://10.0.0.5:9999" }))).toBe(false);
	});

	it("allows a request without Origin header (non-browser client)", () => {
		expect(checkOrigin(reqWith({ host: "10.0.0.5:4242" }))).toBe(true);
	});

	it("rejects an unparseable Origin header", () => {
		expect(checkOrigin(reqWith({ host: "10.0.0.5:4242", origin: "not a url" }))).toBe(false);
	});

	// Host-rewriting tunnel proxies: Host arrives as localhost:<port>, the
	// public hostname rides in X-Forwarded-Host — honored only while a custom
	// provider is configured, because the header is client-controlled on a
	// direct connection.
	describe("with a custom tunnel provider configured", () => {
		beforeEach(() => {
			tunnelProviderMocks.customActive.value = true;
		});
		afterEach(() => {
			tunnelProviderMocks.customActive.value = false;
		});

		it("allows Origin matching X-Forwarded-Host when the proxy rewrote Host", () => {
			expect(checkOrigin(reqWith({
				host: "localhost:4242",
				"x-forwarded-host": "me-app.tunnel.example.com",
				origin: "https://me-app.tunnel.example.com",
			}))).toBe(true);
		});

		it("uses only the first X-Forwarded-Host entry when proxies chain", () => {
			expect(checkOrigin(reqWith({
				host: "localhost:4242",
				"x-forwarded-host": "me-app.tunnel.example.com, inner.proxy.local",
				origin: "https://me-app.tunnel.example.com",
			}))).toBe(true);
			expect(checkOrigin(reqWith({
				host: "localhost:4242",
				"x-forwarded-host": "me-app.tunnel.example.com, evil.example.com",
				origin: "https://evil.example.com",
			}))).toBe(false);
		});

		it("still rejects a foreign origin when X-Forwarded-Host is present", () => {
			expect(checkOrigin(reqWith({
				host: "localhost:4242",
				"x-forwarded-host": "me-app.tunnel.example.com",
				origin: "https://evil.example.com",
			}))).toBe(false);
		});
	});

	// The case that would have caught the ungated version: an attacker who
	// controls the request controls BOTH Origin and X-Forwarded-Host, making
	// the check compare a value against itself.
	it("rejects an attacker setting both Origin and X-Forwarded-Host on the default provider", () => {
		expect(checkOrigin(reqWith({
			host: "abc.trycloudflare.com",
			"x-forwarded-host": "evil.com",
			origin: "https://evil.com",
		}))).toBe(false);
		expect(checkOrigin(reqWith({
			host: "192.168.1.5:4242",
			"x-forwarded-host": "evil.com",
			origin: "https://evil.com",
		}))).toBe(false);
	});

	it("ignores X-Forwarded-Host entirely while the built-in provider is active", () => {
		// Host-preserving cloudflared still matches on Host, so nothing breaks…
		expect(checkOrigin(reqWith({
			host: "abc.trycloudflare.com",
			"x-forwarded-host": "whatever.example.com",
			origin: "https://abc.trycloudflare.com",
		}))).toBe(true);
		// …and a rewritten Host without a custom provider does not authenticate.
		expect(checkOrigin(reqWith({
			host: "localhost:4242",
			"x-forwarded-host": "me-app.tunnel.example.com",
			origin: "https://me-app.tunnel.example.com",
		}))).toBe(false);
	});
});

// ── /auth/exchange ───────────────────────────────────────────────────

describe("handleAuthExchange (QR flow)", () => {
	it("exchanges a valid QR token for a session cookie", async () => {
		const qr = await createQrToken();
		const resp = await handleAuthExchange(exchangeRequest(qr));
		expect(resp.status).toBe(200);
		const setCookie = resp.headers.get("set-cookie");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(cookieValue(setCookie)).toBeTruthy();
		// Body must NOT leak the token — the cookie is the only carrier.
		const body = await resp.json();
		expect(body).toEqual({ ok: true });
	});

	it("rejects a replayed QR token with 401 and no cookie", async () => {
		const qr = await createQrToken();
		await handleAuthExchange(exchangeRequest(qr));
		const resp = await handleAuthExchange(exchangeRequest(qr));
		expect(resp.status).toBe(401);
		expect(resp.headers.get("set-cookie")).toBeNull();
	});

	it("rejects a garbage token with 401", async () => {
		const resp = await handleAuthExchange(exchangeRequest("not.a.jwt"));
		expect(resp.status).toBe(401);
	});

	it("rejects a missing token with 400", async () => {
		const req = new Request("http://h/auth/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json", host: "h" },
			body: JSON.stringify({}),
		});
		const resp = await handleAuthExchange(req);
		expect(resp.status).toBe(400);
	});

	it("rejects a foreign Origin with 403 before touching the body", async () => {
		const qr = await createQrToken();
		const resp = await handleAuthExchange(exchangeRequest(qr, { origin: "http://evil.example.com" }));
		expect(resp.status).toBe(403);
	});

	it("fires onQrConsumed on success only", async () => {
		const onQrConsumed = vi.fn();
		await handleAuthExchange(exchangeRequest("bad-token"), { onQrConsumed });
		expect(onQrConsumed).not.toHaveBeenCalled();
		const qr = await createQrToken();
		await handleAuthExchange(exchangeRequest(qr), { onQrConsumed });
		expect(onQrConsumed).toHaveBeenCalledOnce();
	});
});

describe("handleAuthExchange (static code)", () => {
	beforeEach(() => {
		process.env.DEV3_REMOTE_STATIC_CODE = "sesame42";
		settingsMocks.settings.value = { theme: "light", resolvedTheme: "light" };
	});

	afterEach(() => {
		settingsMocks.settings.value = { theme: "light", resolvedTheme: "light" };
	});

	it("accepts the static code and sets a session cookie", async () => {
		const resp = await handleAuthExchange(exchangeRequest("sesame42"));
		expect(resp.status).toBe(200);
		expect(cookieValue(resp.headers.get("set-cookie"))).toBeTruthy();
	});

	it("rejects a wrong code with 401", async () => {
		const resp = await handleAuthExchange(exchangeRequest("wrong123"));
		expect(resp.status).toBe(401);
	});

	// The static code used to disable the QR exchange entirely, which meant a new
	// device could not be onboarded by scanning while a code was configured.
	it("accepts a valid QR JWT while a static code is also configured", async () => {
		const qr = await createQrToken();
		const resp = await handleAuthExchange(exchangeRequest(qr));
		expect(resp.status).toBe(200);
		expect(cookieValue(resp.headers.get("set-cookie"))).toBeTruthy();
	});

	it("still rejects a consumed QR token on its own merits", async () => {
		const qr = await createQrToken();
		expect((await handleAuthExchange(exchangeRequest(qr))).status).toBe(200);
		expect((await handleAuthExchange(exchangeRequest(qr))).status).toBe(401);
	});

	it("accepts the same code over and over — it is permanent and multi-use", async () => {
		for (let i = 0; i < 3; i++) {
			const resp = await handleAuthExchange(exchangeRequest("sesame42"));
			expect(resp.status).toBe(200);
			expect(cookieValue(resp.headers.get("set-cookie"))).toBeTruthy();
		}
	});

	it("falls back to the settings file when the env var is unset", async () => {
		delete process.env.DEV3_REMOTE_STATIC_CODE;
		settingsMocks.settings.value = { theme: "light", resolvedTheme: "light", staticAccessCode: "from-settings" };
		expect((await handleAuthExchange(exchangeRequest("from-settings"))).status).toBe(200);
		expect((await handleAuthExchange(exchangeRequest("sesame42"))).status).toBe(401);
	});

	// Arseny's ruling: a settings code below the floor is DROPPED and logged once.
	// The Settings field refuses to save one, but that check does not cover a
	// hand-edited settings.json or a code saved before the check existed.
	it("drops a settings code that is too short instead of honouring it", async () => {
		delete process.env.DEV3_REMOTE_STATIC_CODE;
		resetWeakSettingsCodeWarning();
		settingsMocks.settings.value = { theme: "light", resolvedTheme: "light", staticAccessCode: "short" };
		expect(getStaticCode()).toBeNull();
		expect((await handleAuthExchange(exchangeRequest("short"))).status).toBe(401);
	});

	// Dropping it must never take the server down — this source is UI-editable and
	// the boot check is a top-level await, so a throw would strand the user.
	it("keeps serving one-time QR links after dropping a short settings code", async () => {
		delete process.env.DEV3_REMOTE_STATIC_CODE;
		resetWeakSettingsCodeWarning();
		settingsMocks.settings.value = { theme: "light", resolvedTheme: "light", staticAccessCode: "short" };
		const qr = await createQrToken();
		expect((await handleAuthExchange(exchangeRequest(qr))).status).toBe(200);
	});

	it("lets the env var win over the settings file", async () => {
		settingsMocks.settings.value = { theme: "light", resolvedTheme: "light", staticAccessCode: "from-settings" };
		expect((await handleAuthExchange(exchangeRequest("sesame42"))).status).toBe(200);
		expect((await handleAuthExchange(exchangeRequest("from-settings"))).status).toBe(401);
	});
});

// ── Brute-force throttle ─────────────────────────────────────────────

describe("handleAuthExchange throttling", () => {
	beforeEach(() => {
		process.env.DEV3_REMOTE_STATIC_CODE = "sesame42";
	});

	it("429s a guessing peer once it burns its budget, and stops evaluating codes", async () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
			const resp = await handleAuthExchange(exchangeRequest(`guess-${i}`), { rateLimitKey: "10.0.0.9" });
			expect(resp.status).toBe(401);
		}
		const blocked = await handleAuthExchange(exchangeRequest("guess-next"), { rateLimitKey: "10.0.0.9" });
		expect(blocked.status).toBe(429);
		expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

		// Even the correct code is refused while the budget is spent — the throttle
		// runs before the comparison, so a blocked attacker learns nothing.
		const correctWhileBlocked = await handleAuthExchange(exchangeRequest("sesame42"), { rateLimitKey: "10.0.0.9" });
		expect(correctWhileBlocked.status).toBe(429);
	});

	it("never locks out another peer — the owner's device still enrols", async () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT + 3; i++) {
			await handleAuthExchange(exchangeRequest(`guess-${i}`), { rateLimitKey: "10.0.0.9" });
		}
		const owner = await handleAuthExchange(exchangeRequest("sesame42"), { rateLimitKey: "10.0.0.42" });
		expect(owner.status).toBe(200);
		expect(cookieValue(owner.headers.get("set-cookie"))).toBeTruthy();
	});

	it("lets several devices enrol back to back on one key — success is never counted", async () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT * 3; i++) {
			const resp = await handleAuthExchange(exchangeRequest("sesame42"), { rateLimitKey: "10.0.0.42" });
			expect(resp.status).toBe(200);
		}
	});

	it("clears the record on success, so a typo before the right code costs nothing", async () => {
		for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i++) {
			await handleAuthExchange(exchangeRequest("typo1234"), { rateLimitKey: "10.0.0.42" });
		}
		expect((await handleAuthExchange(exchangeRequest("sesame42"), { rateLimitKey: "10.0.0.42" })).status).toBe(200);
		// Budget is full again: another run of failures still fits before a 429.
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
			const resp = await handleAuthExchange(exchangeRequest("typo1234"), { rateLimitKey: "10.0.0.42" });
			expect(resp.status).toBe(401);
		}
	});

	it("throttles QR-token guessing too, not just the static code", async () => {
		delete process.env.DEV3_REMOTE_STATIC_CODE;
		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
			expect((await handleAuthExchange(exchangeRequest(`bad.${i}`), { rateLimitKey: "10.0.0.9" })).status).toBe(401);
		}
		expect((await handleAuthExchange(exchangeRequest("bad.x"), { rateLimitKey: "10.0.0.9" })).status).toBe(429);
	});
});

// ── Startup gate on a weak static code ───────────────────────────────

describe("assertStaticCodeStrongEnough", () => {
	it("passes when no static code is configured", () => {
		delete process.env.DEV3_REMOTE_STATIC_CODE;
		expect(() => assertStaticCodeStrongEnough()).not.toThrow();
	});

	it("throws on a code set straight into the env below the minimum", () => {
		process.env.DEV3_REMOTE_STATIC_CODE = "a".repeat(MIN_REMOTE_STATIC_CODE_LENGTH - 1);
		expect(() => assertStaticCodeStrongEnough()).toThrow(/at least 8 characters/);
	});

	it("accepts exactly the minimum", () => {
		process.env.DEV3_REMOTE_STATIC_CODE = "a".repeat(MIN_REMOTE_STATIC_CODE_LENGTH);
		expect(() => assertStaticCodeStrongEnough()).not.toThrow();
	});

	// The gate runs as a top-level await on the app's boot path, so whatever it
	// can throw on can take the whole app down. That is acceptable for an env var
	// (unattended, and the CLI already rejected it) and NOT acceptable for a
	// UI-editable source: a typo in a settings field would leave a dead app with
	// no way to fix it from inside the app. Pinned at source level because the
	// second source does not exist here yet — this fails the moment someone
	// "tidies" the body into getStaticCode(), which is where that source lands.
	it("reads the env var directly, never the resolved code", () => {
		const src = readFileSync(new URL("../remote-access-server.ts", import.meta.url), "utf8");
		const body = src.slice(src.indexOf("export function assertStaticCodeStrongEnough"));
		const fn = body.slice(0, body.indexOf("\n}\n") + 3);
		expect(fn).toContain("process.env.DEV3_REMOTE_STATIC_CODE");
		expect(fn).not.toContain("getStaticCode(");
	});

	it("never puts the code itself in the error message (it reaches the log)", () => {
		process.env.DEV3_REMOTE_STATIC_CODE = "hunter2";
		let message = "";
		try {
			assertStaticCodeStrongEnough();
		} catch (err) {
			message = String(err);
		}
		expect(message).toContain("at least 8 characters");
		expect(message).not.toContain("hunter2");
	});
});

// ── /auth/refresh ────────────────────────────────────────────────────

describe("handleAuthRefresh", () => {
	async function obtainSessionCookie(): Promise<string> {
		const qr = await createQrToken();
		const resp = await handleAuthExchange(exchangeRequest(qr));
		const token = cookieValue(resp.headers.get("set-cookie"));
		return `${SESSION_COOKIE_NAME}=${token}`;
	}

	it("rolls a valid session cookie forward", async () => {
		const cookie = await obtainSessionCookie();
		const resp = await handleAuthRefresh(refreshRequest(cookie));
		expect(resp.status).toBe(200);
		const newToken = cookieValue(resp.headers.get("set-cookie"));
		expect(newToken).toBeTruthy();
		expect(`${SESSION_COOKIE_NAME}=${newToken}`).not.toBe(cookie);
	});

	it("returns 401 when no cookie is present (boot with no session)", async () => {
		const resp = await handleAuthRefresh(refreshRequest());
		expect(resp.status).toBe(401);
	});

	it("returns 401 and clears the cookie for a tampered session", async () => {
		const resp = await handleAuthRefresh(refreshRequest(`${SESSION_COOKIE_NAME}=aaa.bbb.ccc`));
		expect(resp.status).toBe(401);
		expect(resp.headers.get("set-cookie")).toContain("Max-Age=0");
	});

	it("rejects a foreign Origin with 403 (CSRF guard)", async () => {
		const cookie = await obtainSessionCookie();
		const resp = await handleAuthRefresh(refreshRequest(cookie, { origin: "http://evil.example.com" }));
		expect(resp.status).toBe(403);
	});

	it("a session survives an app restart (persisted secret)", async () => {
		const cookie = await obtainSessionCookie();
		// Simulate restart: in-memory secret wiped, re-initialized from the same file.
		_resetForTests();
		await initSecret(testSecretFile);
		const resp = await handleAuthRefresh(refreshRequest(cookie));
		expect(resp.status).toBe(200);
	});

	it("a session dies when the secret file is lost (fresh secret)", async () => {
		const cookie = await obtainSessionCookie();
		_resetForTests();
		rmSync(testSecretDir, { recursive: true, force: true });
		await initSecret(testSecretFile);
		const resp = await handleAuthRefresh(refreshRequest(cookie));
		expect(resp.status).toBe(401);
	});
});
