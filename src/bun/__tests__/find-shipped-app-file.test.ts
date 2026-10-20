import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT_PATH = join(repoRoot, "scripts/find-shipped-app-file.sh");
const CLI_SUFFIX = "Resources/app/cli/dev3";
const APP_CLI = "dev-3.0-canary.app/Contents/Resources/app/cli/dev3";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "dev3-find-shipped-"));
	tempDirs.push(dir);
	return dir;
}

function touch(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "bin");
	return path;
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
	return spawnSync("bash", [SCRIPT_PATH, ...args], { cwd, encoding: "utf8", env });
}

describe("find-shipped-app-file.sh", () => {
	it("prefers the extracted payload when electrobun packed one (the arm64 green-run layout)", () => {
		const dir = fixture();
		const payloadCli = touch(join(dir, "eb-payload", APP_CLI));
		touch(join(dir, "build/canary-macos-arm64", APP_CLI));

		const result = run(dir, [CLI_SUFFIX, join(dir, "eb-payload"), "./build"]);

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(payloadCli);
	});

	// Run 39497884609 (macOS x64): `stapler staple` failed, so no payload was packed
	// and eb-payload never existed. The old `find <missing> ./build | head -1` under
	// pipefail killed the step with exit 1 and no message although ./build had the CLI.
	it("finds the file in ./build when the payload root does not exist", () => {
		const dir = fixture();
		touch(join(dir, "build/canary-macos-x64", APP_CLI));

		const result = run(dir, [CLI_SUFFIX, join(dir, "eb-payload"), "./build"]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(`./build/canary-macos-x64/${APP_CLI}`);
	});

	it("fails with a message naming the searched roots when the file is genuinely missing", () => {
		const dir = fixture();
		mkdirSync(join(dir, "eb-payload/dev-3.0-canary.app/Contents/Resources/app/bun"), { recursive: true });
		mkdirSync(join(dir, "build/canary-macos-x64"), { recursive: true });

		const result = run(dir, [CLI_SUFFIX, join(dir, "eb-payload"), "./build"]);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`::error::no ${CLI_SUFFIX} found under: ${join(dir, "eb-payload")} ./build`);
	});

	it("fails when none of the roots exist instead of reporting an empty success", () => {
		const dir = fixture();

		const result = run(dir, [CLI_SUFFIX, join(dir, "eb-payload"), "./build"]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("none of the search roots exist");
	});

	it("fails with exit 2 when find itself errors on a root that exists", () => {
		const dir = fixture();
		touch(join(dir, "build/canary-macos-x64", APP_CLI));
		const fakeBin = join(dir, "fake-bin");
		mkdirSync(fakeBin);
		writeFileSync(join(fakeBin, "find"), "#!/bin/sh\necho 'find: ./build/x: Permission denied' >&2\nexit 1\n");
		chmodSync(join(fakeBin, "find"), 0o755);

		const result = run(dir, [CLI_SUFFIX, "./build"], { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` });

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("::error::searching ./build for");
		expect(result.stderr).toContain("Permission denied");
	});

	it("returns only the first of several matches", () => {
		const dir = fixture();
		for (let i = 0; i < 50; i++) touch(join(dir, `build/copy-${i}`, APP_CLI));

		const result = run(dir, [CLI_SUFFIX, "./build"]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(result.stdout).toContain(APP_CLI);
	});
});

describe("release-build-macos.yml JIT entitlements gate", () => {
	const workflow = readFileSync(join(repoRoot, ".github/workflows/release-build-macos.yml"), "utf8");
	const start = workflow.indexOf("- name: Verify CLI binary can run bun:ffi (JIT entitlements gate)");
	const end = workflow.indexOf("- name:", start + 1);
	const step = workflow.slice(start, end);

	it("exists", () => {
		expect(start, "the JIT entitlements gate step was renamed or removed — update this test, do not drop the gate").toBeGreaterThan(-1);
		expect(step).toContain("set -euo pipefail");
	});

	it("looks up the shipped CLI and worker through the helper, payload first", () => {
		for (const suffix of ["Resources/app/cli/dev3", "Resources/app/workers/clonefile-worker.js"]) {
			expect(step).toContain(
				`bash scripts/find-shipped-app-file.sh "${suffix}" "$RUNNER_TEMP/eb-payload" ./build`,
			);
		}
	});

	it("never pipes find into head under pipefail", () => {
		expect(step).not.toMatch(/find[^\n]*\|\s*head/);
	});
});
