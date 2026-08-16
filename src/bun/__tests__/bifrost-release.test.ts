import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BIFROST_TARGETS, BIFROST_VERSION, bifrostPinKey, bifrostTarget } from "../../shared/bifrost-release";

describe("bifrostTarget", () => {
	it("uses the vendor's own platform and arch names, not Node's", () => {
		expect(bifrostTarget("darwin", "x64")?.url).toContain("/darwin/amd64/");
		expect(bifrostTarget("win32", "x64")?.url).toContain("/windows/amd64/");
		expect(bifrostTarget("linux", "ia32")?.url).toContain("/linux/386/");
	});

	it("gives Windows the executable extension", () => {
		expect(bifrostTarget("win32", "x64")?.binaryName).toBe("bifrost-http.exe");
		expect(bifrostTarget("darwin", "arm64")?.binaryName).toBe("bifrost-http");
	});

	it("pins the version into the download path", () => {
		expect(bifrostTarget("darwin", "arm64")?.url).toContain(`/${BIFROST_VERSION}/`);
	});

	it("refuses to guess a URL for a target the vendor does not publish", () => {
		expect(bifrostTarget("darwin", "ia32")).toBeUndefined();
		expect(bifrostTarget("freebsd", "x64")).toBeUndefined();
		expect(bifrostTarget("linux", "mips")).toBeUndefined();
	});

	it("has a resolvable download for every target dev3 ships", () => {
		for (const { platform, arch } of BIFROST_TARGETS) {
			expect(bifrostTarget(platform, arch), `${platform}/${arch}`).toBeTruthy();
		}
	});

	it("keys a pin by platform and arch, so one hash cannot cover two builds", () => {
		expect(bifrostPinKey("darwin", "arm64")).toBe("darwin-arm64");
		expect(new Set(BIFROST_TARGETS.map((t) => bifrostPinKey(t.platform, t.arch))).size).toBe(BIFROST_TARGETS.length);
	});
});

/**
 * Release CI runs `scripts/fetch-bifrost.ts` on five runners, and that script
 * exits non-zero when its own target is unpinned. A pin file recorded on one
 * machine therefore fails the other four builds — 40 minutes into a release,
 * with nothing to see beforehand. These are the checks that fail here instead.
 * Record the whole set with `bun scripts/fetch-bifrost.ts --record --all`.
 */
describe("the recorded pin file", () => {
	const PIN_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/bifrost-pinned.json");
	const pins = (): { version: string; sha256: Record<string, string> } =>
		JSON.parse(readFileSync(PIN_FILE, "utf-8"));

	it("covers every target release CI builds", () => {
		const { version, sha256 } = pins();
		expect(version).toBe(BIFROST_VERSION);
		const missing = BIFROST_TARGETS.map((t) => bifrostPinKey(t.platform, t.arch)).filter((key) => !sha256[key]);
		expect(missing).toEqual([]);
	});

	it("carries no hash for a target dev3 does not ship", () => {
		const shipped = new Set(BIFROST_TARGETS.map((t) => bifrostPinKey(t.platform, t.arch)));
		expect(Object.keys(pins().sha256).filter((key) => !shipped.has(key))).toEqual([]);
	});

	it("records each hash as a full SHA-256", () => {
		for (const [key, digest] of Object.entries(pins().sha256)) {
			expect(digest, key).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});
