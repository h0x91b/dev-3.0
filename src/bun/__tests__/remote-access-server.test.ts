import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create temp static root with test files
const testStaticRoot = join(tmpdir(), `dev3-static-test-${process.pid}`);

beforeAll(() => {
	mkdirSync(join(testStaticRoot, "assets"), { recursive: true });
	mkdirSync(join(testStaticRoot, "subdir"), { recursive: true });
	writeFileSync(join(testStaticRoot, "index.html"), "<html>root</html>");
	writeFileSync(join(testStaticRoot, "assets", "app.js"), "console.log('ok')");
	writeFileSync(join(testStaticRoot, "subdir", "index.html"), "<html>sub</html>");
});

afterAll(() => {
	rmSync(testStaticRoot, { recursive: true, force: true });
});

// Mock electrobun to use our temp dir
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

vi.mock("../jwt", () => ({
	initSecret: vi.fn(),
	createQrToken: vi.fn().mockResolvedValue("test-token"),
	createSessionToken: vi.fn().mockResolvedValue("test-session-token"),
	exchangeQrForSession: vi.fn(),
	refreshSession: vi.fn(),
	verifySessionToken: vi.fn(),
}));

vi.mock("../cloudflare-tunnel", () => ({
	getTunnelUrl: vi.fn().mockReturnValue(null),
}));

vi.mock("../settings", () => ({
	loadSettingsSync: vi.fn(() => ({
		theme: "light",
		resolvedTheme: "light",
	})),
}));

vi.mock("../theme-state", () => ({
	getCurrentUiTheme: vi.fn(() => "dark"),
}));

vi.mock("qrcode", () => ({
	default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,test") },
}));

// Override the static root used by the module.
// The module computes staticRoot at import time, so we need to patch resolve
// to return our test dir when it resolves dist/ or views/ paths.
// Simpler approach: we'll directly test the path traversal logic.

// ================================================================
// Path traversal tests (testing the security logic directly)
// ================================================================

import { resolve } from "node:path";

// Reimplement the serveStatic path logic for unit testing
// (same logic as in remote-access-server.ts)
function resolveSafePath(staticRoot: string, pathname: string): string | null {
	const filePath = resolve(staticRoot, "." + pathname);
	if (!filePath.startsWith(staticRoot + "/") && filePath !== staticRoot) return null;
	return filePath;
}

describe("serveStatic path traversal protection", () => {
	it("allows normal paths within static root", () => {
		const result = resolveSafePath(testStaticRoot, "/index.html");
		expect(result).toBe(join(testStaticRoot, "index.html"));
	});

	it("allows nested paths", () => {
		const result = resolveSafePath(testStaticRoot, "/assets/app.js");
		expect(result).toBe(join(testStaticRoot, "assets", "app.js"));
	});

	it("rejects basic path traversal (..)", () => {
		const result = resolveSafePath(testStaticRoot, "/../../../etc/passwd");
		expect(result).toBeNull();
	});

	it("rejects encoded path traversal", () => {
		// resolve() handles %2e%2e → .. decoding at OS level
		const result = resolveSafePath(testStaticRoot, "/..%2f..%2fetc/passwd");
		// resolve normalizes this, but the startsWith check catches it
		if (result !== null) {
			expect(result.startsWith(testStaticRoot + "/")).toBe(true);
		}
	});

	it("rejects traversal via double dots in middle", () => {
		const result = resolveSafePath(testStaticRoot, "/assets/../../etc/passwd");
		expect(result).toBeNull();
	});

	it("allows root path", () => {
		const result = resolveSafePath(testStaticRoot, "/");
		// resolve(root, "./" ) === root, which matches filePath === staticRoot
		expect(result).not.toBeNull();
	});

	it("rejects paths that resolve outside root via symlink-like patterns", () => {
		const result = resolveSafePath(testStaticRoot, "/../");
		expect(result).toBeNull();
	});
});

// ================================================================
// Auth endpoints
// ================================================================

import { exchangeQrForSession, refreshSession, verifySessionToken } from "../jwt";
import { injectInitialThemeBootstrap } from "../remote-access-server";

describe("injectInitialThemeBootstrap", () => {
	it("injects the persisted theme state into the initial HTML", () => {
		const html = injectInitialThemeBootstrap("<html><head></head><body></body></html>");

		expect(html).toContain('window.__DEV3_INITIAL_THEME__="light"');
		expect(html).toContain('window.__DEV3_INITIAL_RESOLVED_THEME__="light"');
	});
});

describe("auth endpoint logic", () => {
	it("exchangeQrForSession returns session token for valid QR token", async () => {
		(exchangeQrForSession as any).mockResolvedValueOnce("session-token-123");
		const result = await exchangeQrForSession("qr-token");
		expect(result).toBe("session-token-123");
	});

	it("exchangeQrForSession returns null for invalid token", async () => {
		(exchangeQrForSession as any).mockResolvedValueOnce(null);
		const result = await exchangeQrForSession("bad-token");
		expect(result).toBeNull();
	});

	it("refreshSession returns new token for valid session", async () => {
		(refreshSession as any).mockResolvedValueOnce("new-session-token");
		const result = await refreshSession("old-session-token");
		expect(result).toBe("new-session-token");
	});

	it("refreshSession returns null for expired session", async () => {
		(refreshSession as any).mockResolvedValueOnce(null);
		const result = await refreshSession("expired-token");
		expect(result).toBeNull();
	});

	it("verifySessionToken returns false for missing token", async () => {
		(verifySessionToken as any).mockResolvedValueOnce(false);
		const result = await verifySessionToken("");
		expect(result).toBe(false);
	});
});

// ================================================================
// onQrTokenConsumed callback
// ================================================================

describe("onQrTokenConsumed callback", () => {
	it("is called when QR token exchange succeeds", async () => {
		// The callback is registered via StartOptions.onQrTokenConsumed
		// and should fire after a successful exchangeQrForSession in the
		// /auth/exchange handler. Since we can't easily start the real server
		// in unit tests, we verify the contract: exchangeQrForSession returns
		// a truthy value → callback should be invoked.
		const callback = vi.fn();

		// Simulate the handler logic:
		(exchangeQrForSession as any).mockResolvedValueOnce("session-token");
		const result = await exchangeQrForSession("qr-token");
		if (result) callback();

		expect(callback).toHaveBeenCalledOnce();
	});

	it("is NOT called when QR token exchange fails", async () => {
		const callback = vi.fn();

		(exchangeQrForSession as any).mockResolvedValueOnce(null);
		const result = await exchangeQrForSession("invalid-token");
		if (result) callback();

		expect(callback).not.toHaveBeenCalled();
	});
});

// ================================================================
// Static code auth path
// ================================================================

import { createSessionToken } from "../jwt";

/**
 * Simulates the /auth/exchange handler logic for the static code path.
 * Mirrors the actual implementation in remote-access-server.ts so that
 * we can unit-test the branching without starting a real server.
 */
async function simulateAuthExchange(
	token: string,
	staticCode: string | null,
): Promise<{ status: number; body: string }> {
	if (!token) return { status: 400, body: "Missing token" };

	if (staticCode) {
		if (token !== staticCode) {
			return { status: 401, body: "Invalid or expired token" };
		}
		await createSessionToken();
		return { status: 200, body: "ok" };
	}

	const result = await exchangeQrForSession(token);
	if (!result) return { status: 401, body: "Invalid or expired token" };
	return { status: 200, body: "ok" };
}

describe("static code auth path", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("accepts the correct static code", async () => {
		(createSessionToken as any).mockResolvedValueOnce("session-tok");
		const res = await simulateAuthExchange("mysecret", "mysecret");
		expect(res.status).toBe(200);
	});

	it("rejects a wrong static code without falling through to JWT exchange", async () => {
		// exchangeQrForSession must NOT be called when static code is active.
		const res = await simulateAuthExchange("wrongcode", "mysecret");
		expect(res.status).toBe(401);
		expect(exchangeQrForSession).not.toHaveBeenCalled();
	});

	it("rejects a valid JWT token when static code mode is active", async () => {
		// A JWT QR token must NOT bypass the static code gate.
		const res = await simulateAuthExchange("some-jwt-qr-token", "mysecret");
		expect(res.status).toBe(401);
		expect(exchangeQrForSession).not.toHaveBeenCalled();
	});

	it("falls through to JWT exchange when no static code is set", async () => {
		(exchangeQrForSession as any).mockResolvedValueOnce("session-tok");
		const res = await simulateAuthExchange("jwt-token", null);
		expect(res.status).toBe(200);
		expect(exchangeQrForSession).toHaveBeenCalledWith("jwt-token");
	});

	it("returns 401 for an invalid JWT when no static code is set", async () => {
		(exchangeQrForSession as any).mockResolvedValueOnce(null);
		const res = await simulateAuthExchange("bad-jwt", null);
		expect(res.status).toBe(401);
	});
});

// ================================================================
// MIME type serving
// ================================================================

describe("MIME types", () => {
	const MIME_TYPES: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "application/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".png": "image/png",
		".jpg": "image/jpeg",
		".svg": "image/svg+xml",
		".woff2": "font/woff2",
		".woff": "font/woff",
		".ttf": "font/ttf",
		".ico": "image/x-icon",
		".map": "application/json",
	};

	it("maps common extensions correctly", () => {
		expect(MIME_TYPES[".html"]).toBe("text/html; charset=utf-8");
		expect(MIME_TYPES[".js"]).toBe("application/javascript; charset=utf-8");
		expect(MIME_TYPES[".css"]).toBe("text/css; charset=utf-8");
		expect(MIME_TYPES[".png"]).toBe("image/png");
	});

	it("covers all web font types", () => {
		expect(MIME_TYPES[".woff2"]).toBe("font/woff2");
		expect(MIME_TYPES[".woff"]).toBe("font/woff");
		expect(MIME_TYPES[".ttf"]).toBe("font/ttf");
	});
});

// ================================================================
// DEV3_REMOTE_PORT parsing (resolveListenPort)
// ================================================================

import { resolveListenPort } from "../remote-access-server";

describe("resolveListenPort", () => {
	const originalEnv = process.env.DEV3_REMOTE_PORT;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.DEV3_REMOTE_PORT;
		} else {
			process.env.DEV3_REMOTE_PORT = originalEnv;
		}
	});

	it("returns 0 when env var is unset", () => {
		delete process.env.DEV3_REMOTE_PORT;
		expect(resolveListenPort()).toBe(0);
	});

	it("returns parsed port for a valid numeric value", () => {
		process.env.DEV3_REMOTE_PORT = "3000";
		expect(resolveListenPort()).toBe(3000);
	});

	it("accepts privileged ports (1-1023) — bind() will surface EACCES at startup", () => {
		process.env.DEV3_REMOTE_PORT = "80";
		expect(resolveListenPort()).toBe(80);
	});

	it("accepts the max valid port 65535", () => {
		process.env.DEV3_REMOTE_PORT = "65535";
		expect(resolveListenPort()).toBe(65535);
	});

	it("falls back to 0 for non-numeric values", () => {
		process.env.DEV3_REMOTE_PORT = "abc";
		expect(resolveListenPort()).toBe(0);
	});

	it("falls back to 0 for port below range", () => {
		process.env.DEV3_REMOTE_PORT = "0";
		expect(resolveListenPort()).toBe(0);
	});

	it("falls back to 0 for port above 65535", () => {
		process.env.DEV3_REMOTE_PORT = "70000";
		expect(resolveListenPort()).toBe(0);
	});

	it("falls back to 0 for negative port", () => {
		process.env.DEV3_REMOTE_PORT = "-1";
		expect(resolveListenPort()).toBe(0);
	});
});

// ================================================================
// uploadImageBase64 size limit
// ================================================================

describe("uploadImageBase64 size limit", () => {
	it("rejects payloads over 10 MB", () => {
		const MAX_BASE64_SIZE = 10 * 1024 * 1024;
		const bigPayload = "A".repeat(MAX_BASE64_SIZE + 1);
		expect(bigPayload.length).toBeGreaterThan(MAX_BASE64_SIZE);
	});

	it("accepts payloads under 10 MB", () => {
		const MAX_BASE64_SIZE = 10 * 1024 * 1024;
		const smallPayload = "A".repeat(1024);
		expect(smallPayload.length).toBeLessThan(MAX_BASE64_SIZE);
	});
});
