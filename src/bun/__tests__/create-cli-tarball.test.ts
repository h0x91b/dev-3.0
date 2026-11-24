import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/create-cli-tarball.sh", import.meta.url));
const publicDir = fileURLToPath(new URL("../../mainview/public", import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
	for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "dev3-cli-tarball-"));
	fixtures.push(dir);
	for (const path of ["dist/workers", "src/assets/artifact-template", "src/mainview", "scratch"]) {
		mkdirSync(join(dir, path), { recursive: true });
	}
	cpSync(publicDir, join(dir, "src/mainview/public"), { recursive: true });
	mkdirSync(join(dir, "src/mainview/public/future assets"));
	writeFileSync(join(dir, "src/mainview/public/future assets/nested.js"), "nested fixture");
	cpSync(join(dir, "src/mainview/public"), join(dir, "dist"), { recursive: true });
	writeFileSync(join(dir, "dist/dev3"), "cli fixture");
	writeFileSync(join(dir, "dist/index.html"), "<!doctype html><title>App</title>");
	writeFileSync(join(dir, "dist/workers/worktree-cleanup-worker.js"), "worker fixture");
	return dir;
}

function pack(dir: string) {
	return spawnSync("bash", [script, "linux", "x64"], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, TMPDIR: join(dir, "scratch") },
	});
}

describe.skipIf(process.platform === "win32")("CLI release public assets", () => {
	it("ships the actual service worker, manifest and nested public assets in the archive", () => {
		const dir = fixture();
		const result = pack(dir);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		const extracted = join(dir, "extracted");
		mkdirSync(extracted);
		const untar = spawnSync("tar", ["xzf", join(dir, "artifacts-linux-x64/dev3-cli-linux-x64.tar.gz"), "-C", extracted]);
		expect(untar.status).toBe(0);
		for (const asset of ["sw.js", "manifest.webmanifest", "favicon.png", "future assets/nested.js"]) {
			expect(readFileSync(join(extracted, "dist", asset))).toEqual(readFileSync(join(dir, "src/mainview/public", asset)));
		}
	});

	it("refuses to publish when Vite's service worker output is missing", () => {
		const dir = fixture();
		rmSync(join(dir, "dist/sw.js"));
		const result = pack(dir);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("dist/sw.js missing");
	});
});
