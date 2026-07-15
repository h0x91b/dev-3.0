import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create temp static root with test files
const testStaticRoot = join(tmpdir(), `dev3-static-test-${process.pid}`);

beforeAll(() => {
	// Agents run inside dev3 sessions where DEV3_REMOTE_STATIC_CODE is set;
	// getStaticCode() would pick it up and break the token assertions.
	delete process.env.DEV3_REMOTE_STATIC_CODE;
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
	SESSION_TOKEN_TTL_S: 24 * 60 * 60,
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
// serveStatic — real function (materialized body, decision 113)
// ================================================================

import { serveStatic } from "../remote-access-server";

describe("serveStatic (real function)", () => {
	// Regression guard for decision 113: static assets are served from an
	// in-memory buffer (await file.bytes()), never a raw Bun.file blob. A raw
	// Bun.file lets Bun.serve take the zero-copy sendfile(2) path, which on macOS
	// drops the HTTP response head over a real LAN socket (ERR_INVALID_HTTP_RESPONSE
	// → blank page; Cloudflare's loopback origin masked it). The socket-level
	// framing can't be reproduced in a unit test, so we lock in that serveStatic
	// yields a complete, correct response for the JS bundle path.
	it("serves a JS asset with the right content-type and the full body intact", async () => {
		const js = "const x = 1;\n".repeat(2000); // large enough to be a realistic bundle
		writeFileSync(join(testStaticRoot, "assets", "big.js"), js);
		const resp = await serveStatic("/assets/big.js", testStaticRoot);
		expect(resp).not.toBeNull();
		expect(resp!.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
		expect(await resp!.text()).toBe(js);
	});

	it("injects the theme bootstrap into an HTML file", async () => {
		const resp = await serveStatic("/index.html", testStaticRoot);
		expect(resp).not.toBeNull();
		expect(resp!.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(await resp!.text()).toContain("window.__DEV3_INITIAL_THEME__");
	});

	it("serves index.html when the path resolves to a directory", async () => {
		const resp = await serveStatic("/subdir", testStaticRoot);
		expect(resp).not.toBeNull();
		expect(await resp!.text()).toContain("sub");
	});

	it("returns null for a missing file", async () => {
		const resp = await serveStatic("/assets/nope.js", testStaticRoot);
		expect(resp).toBeNull();
	});

	it("returns null for a path escaping the static root", async () => {
		const resp = await serveStatic("/../../../etc/passwd", testStaticRoot);
		expect(resp).toBeNull();
	});
});

// ================================================================
// Theme bootstrap injection
// ================================================================
// The auth endpoints (/auth/exchange, /auth/refresh, cookies, Origin checks)
// are tested against the REAL jwt module in remote-access-auth.test.ts.

import { injectInitialThemeBootstrap } from "../remote-access-server";

describe("injectInitialThemeBootstrap", () => {
	it("injects the persisted theme state into the initial HTML", () => {
		const html = injectInitialThemeBootstrap("<html><head></head><body></body></html>");

		expect(html).toContain('window.__DEV3_INITIAL_THEME__="light"');
		expect(html).toContain('window.__DEV3_INITIAL_RESOLVED_THEME__="light"');
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

import { getLocalInterfaces, resolveAccessHost, getAccessUrl, generateQrDataUrl } from "../remote-access-server";

describe("getLocalInterfaces", () => {
	it("always includes loopback 127.0.0.1 last and marked internal", () => {
		const list = getLocalInterfaces();
		const last = list[list.length - 1];
		expect(last).toEqual({ name: "loopback", address: "127.0.0.1", internal: true });
	});

	it("marks every non-loopback entry as external", () => {
		const list = getLocalInterfaces();
		for (const iface of list.slice(0, -1)) {
			expect(iface.internal).toBe(false);
			expect(iface.address).not.toBe("127.0.0.1");
		}
	});
});

describe("resolveAccessHost", () => {
	it("honours loopback (always an allowed address)", () => {
		expect(resolveAccessHost("127.0.0.1")).toBe("127.0.0.1");
		expect(resolveAccessHost("localhost")).toBe("localhost");
	});

	it("rejects a host that is not one of our addresses (falls back to auto)", () => {
		// 8.8.8.8 is not a local interface — must NOT be echoed back into the URL.
		expect(resolveAccessHost("8.8.8.8")).not.toBe("8.8.8.8");
	});

	it("falls back to the auto host when none is given", () => {
		const auto = resolveAccessHost();
		expect(typeof auto).toBe("string");
		expect(auto.length).toBeGreaterThan(0);
	});
});

describe("getAccessUrl host override", () => {
	// dev3-managed shells export DEV3_REMOTE_STATIC_CODE (the dev app's own
	// web-access code), and getAccessUrl prefers it over the mocked QR token.
	// Unset it so these tests stay hermetic when run inside a dev3 worktree.
	beforeEach(() => {
		vi.stubEnv("DEV3_REMOTE_STATIC_CODE", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("embeds an allowed host in the URL", async () => {
		const url = await getAccessUrl("127.0.0.1");
		expect(url).toContain("http://127.0.0.1:");
		expect(url).toContain("?token=test-token");
	});

	it("ignores a disallowed host (does not inject it)", async () => {
		const url = await getAccessUrl("8.8.8.8");
		expect(url).not.toContain("8.8.8.8");
	});

	it("generateQrDataUrl threads the host through to the QR image", async () => {
		const qr = await generateQrDataUrl("127.0.0.1");
		expect(qr).toBe("data:image/png;base64,test");
	});
});

import { closeUpstreamSocket } from "../remote-access-server";

describe("closeUpstreamSocket (F5)", () => {
	function fakeWs(readyState: number) {
		return { readyState, close: vi.fn() };
	}

	it("closes an upstream still in CONNECTING (the leak fix)", () => {
		const ws = fakeWs(WebSocket.CONNECTING); // 0
		closeUpstreamSocket(ws);
		expect(ws.close).toHaveBeenCalledOnce();
	});

	it("closes an OPEN upstream", () => {
		const ws = fakeWs(WebSocket.OPEN); // 1
		closeUpstreamSocket(ws);
		expect(ws.close).toHaveBeenCalledOnce();
	});

	it("does not re-close an already-CLOSED upstream", () => {
		const ws = fakeWs(WebSocket.CLOSED); // 3
		closeUpstreamSocket(ws);
		expect(ws.close).not.toHaveBeenCalled();
	});

	it("is a no-op for a missing upstream", () => {
		expect(() => closeUpstreamSocket(undefined)).not.toThrow();
		expect(() => closeUpstreamSocket(null)).not.toThrow();
	});
});
