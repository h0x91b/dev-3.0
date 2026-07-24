/**
 * Exercises the standalone CLI wrapper by running it exactly as documented —
 * `bun scripts/native-terminal-host-manifest/generate.ts ...` — against a
 * materialized fixture in a tmp directory. Proves the emitted JSON matches the
 * library output and that rejections/usage errors map to distinct exit codes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateManifest, serializeManifest } from "../manifest";
import { declaredFiles, materializeFixture, WINDOWS_X64_FIXTURE } from "./fixtures";

const GENERATE = join(import.meta.dir, "..", "generate.ts");

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync([process.execPath, GENERATE, ...args], { env: process.env });
	return {
		exitCode: result.exitCode ?? -1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function metadataArgs(): string[] {
	const m = WINDOWS_X64_FIXTURE.metadata;
	return ["--host-version", m.hostVersion, "--protocol-version", String(m.protocolVersion), "--bun-version", m.bunVersion, "--os", m.os, "--arch", m.arch];
}

describe("generate.ts CLI", () => {
	test("emits the same JSON as the library, explicit --file list", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const fileArgs = declaredFiles(WINDOWS_X64_FIXTURE).flatMap((file) => ["--file", file]);
			const { exitCode, stdout } = run(["--root", root, "--entrypoint", WINDOWS_X64_FIXTURE.entrypoint, ...metadataArgs(), ...fileArgs]);
			expect(exitCode).toBe(0);
			const expected = serializeManifest(
				generateManifest({ artifactRoot: root, entrypoint: WINDOWS_X64_FIXTURE.entrypoint, files: declaredFiles(WINDOWS_X64_FIXTURE), metadata: WINDOWS_X64_FIXTURE.metadata }),
			);
			expect(stdout).toBe(expected);
		} finally {
			cleanup();
		}
	});

	test("enumerates the root when no --file is given, matching explicit output", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const enumerated = run(["--root", root, "--entrypoint", WINDOWS_X64_FIXTURE.entrypoint, ...metadataArgs()]);
			const fileArgs = declaredFiles(WINDOWS_X64_FIXTURE).flatMap((file) => ["--file", file]);
			const explicit = run(["--root", root, "--entrypoint", WINDOWS_X64_FIXTURE.entrypoint, ...metadataArgs(), ...fileArgs]);
			expect(enumerated.exitCode).toBe(0);
			expect(enumerated.stdout).toBe(explicit.stdout);
		} finally {
			cleanup();
		}
	});

	test("--out writes the manifest to disk", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const out = join(root, "manifest.json");
			const { exitCode } = run(["--root", root, "--entrypoint", WINDOWS_X64_FIXTURE.entrypoint, ...metadataArgs(), "--out", out]);
			expect(exitCode).toBe(0);
			// The written file excludes itself: it was created after enumeration ran.
			const written = readFileSync(out, "utf8");
			expect(written.endsWith("\n")).toBe(true);
			expect(JSON.parse(written).files.some((entry: { path: string }) => entry.path === "manifest.json")).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("rejection exits 1 with a compact [code] line on stderr", () => {
		const { exitCode, stderr } = run(["--root", join(WINDOWS_X64_FIXTURE.name, "absent-xyz"), "--entrypoint", "x.js", "--file", "x.js", ...metadataArgs()]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("[missing]");
	});

	test("usage errors exit 2", () => {
		const missingFlag = run(["--root", "somewhere"]);
		expect(missingFlag.exitCode).toBe(2);
		expect(missingFlag.stderr).toContain("[usage]");

		const badOs = run(["--root", "somewhere", "--entrypoint", "x.js", "--host-version", "1", "--protocol-version", "2", "--bun-version", "1", "--os", "plan9", "--arch", "x64"]);
		expect(badOs.exitCode).toBe(2);

		const unknownFlag = run(["--frobnicate"]);
		expect(unknownFlag.exitCode).toBe(2);
	});
});
