/**
 * Every public download URL must come from RELEASE_BASE_URL. A build that bakes a different host
 * into its bundle keeps polling that host for as long as it stays installed, so a stray copy is
 * not cosmetic — it is the reason the S3 bucket can never stop being public.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_BASE_URL } from "../../shared/release-feed";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIRECT_BUCKET_URL = /h0x91b-releases\.s3[.\w-]*\.amazonaws\.com/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
		return /\.(ts|tsx|ya?ml)$/.test(name) ? [path] : [];
	});
}

const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

describe("release feed URL", () => {
	it("is the CloudFront hostname, not the bucket", () => {
		expect(RELEASE_BASE_URL).toBe("https://releases.h0x91b.com/dev-3.0");
	});

	it("is never spelled as a direct bucket URL in shipped code or workflows", () => {
		const files = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "scripts")), ...sourceFiles(join(ROOT, ".github/workflows")), join(ROOT, "electrobun.config.ts")];
		const offenders = files.filter((file) => DIRECT_BUCKET_URL.test(readFileSync(file, "utf8")));
		expect(offenders.map((file) => file.slice(ROOT.length + 1)), "download URLs must use RELEASE_BASE_URL from src/shared/release-feed.ts").toEqual([]);
	});

	it("is what release.yml writes into the Homebrew formula and the release notes", () => {
		const body = read(".github/workflows/release.yml");
		expect(body).toContain(`RELEASE_BASE="${RELEASE_BASE_URL}/$TAG"`);
		expect(body).not.toContain("S3_BASE");
	});

	it("is what electrobun bakes into every bundle", () => {
		expect(read("electrobun.config.ts")).toContain("baseUrl: RELEASE_BASE_URL");
	});
});

describe("canary archive", () => {
	for (const os of ["macos", "linux"]) {
		it(`release-build-${os}.yml archives only CLI tarballs for canary`, () => {
			const body = read(`.github/workflows/release-build-${os}.yml`);
			const canary = body.match(/if \[ "\$\{\{ inputs\.channel \}\}" = "canary" \]; then\n([^]*?)\n\s*else/)?.[1] ?? "";
			expect(canary, "canary archive sync not found").toContain('"s3://h0x91b-releases/dev-3.0/$TAG/"');
			expect(canary).toContain('--exclude "*" --include "dev3-cli-*.tar.gz"');
		});
	}

	it("release-build-windows.yml writes no canary archive", () => {
		const body = read(".github/workflows/release-build-windows.yml");
		expect(body).toMatch(/if \[ "\$\{\{ inputs\.channel \}\}" != "canary" \]; then\n\s*aws s3 sync [^\n]*"s3:\/\/h0x91b-releases\/dev-3\.0\/\$TAG\/"\n\s*fi/);
	});
});
