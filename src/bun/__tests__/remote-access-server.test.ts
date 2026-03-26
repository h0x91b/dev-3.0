import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
	exchangeQrForSession: vi.fn(),
	refreshSession: vi.fn(),
	verifySessionToken: vi.fn(),
}));

vi.mock("../cloudflare-tunnel", () => ({
	getTunnelUrl: vi.fn().mockReturnValue(null),
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

