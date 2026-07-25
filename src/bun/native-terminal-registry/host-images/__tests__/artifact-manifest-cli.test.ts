/**
 * Exercises the artifact-manifest generator CLI in-process against a
 * materialized fixture, proving the emitted JSON matches the library output and
 * that rejections and usage errors map to distinct exit codes.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateManifest, serializeManifest } from "../artifact-manifest";
import {
	ARTIFACT_MANIFEST_CLI_OK,
	ARTIFACT_MANIFEST_CLI_REJECTED,
	ARTIFACT_MANIFEST_CLI_USAGE,
	runArtifactManifestCli,
} from "../artifact-manifest-cli";
import { declaredFiles, materializeFixture, WINDOWS_X64_FIXTURE } from "./artifact-manifest-fixtures";

function metadataArgs(): string[] {
	const m = WINDOWS_X64_FIXTURE.metadata;
	return [
		"--host-version",
		m.hostVersion,
		"--protocol-version",
		String(m.protocolVersion),
		"--bun-version",
		m.bunVersion,
		"--os",
		m.os,
		"--arch",
		m.arch,
	];
}

describe("artifact manifest CLI", () => {
	test("emits the same JSON as the library, explicit --file list", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const fileArgs = declaredFiles(WINDOWS_X64_FIXTURE).flatMap((file) => ["--file", file]);
			const result = runArtifactManifestCli(["--root", root, "--entrypoint", WINDOWS_X64_FIXTURE.entrypoint, ...metadataArgs(), ...fileArgs]);
			expect(result.exitCode).toBe(ARTIFACT_MANIFEST_CLI_OK);
			const expected = serializeManifest(
				generateManifest({
					artifactRoot: root,
					entrypoint: WINDOWS_X64_FIXTURE.entrypoint,
					files: declaredFiles(WINDOWS_X64_FIXTURE),
					metadata: WINDOWS_X64_FIXTURE.metadata,
				}),
			);
			expect(result.stdout).toBe(expected);
		} finally {
			cleanup();
		}
	});

	test("enumerates the root when no --file is given, matching explicit output", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const enumerated = runArtifactManifestCli(["--root", root, "--entrypoint", WINDOWS_X64_FIXTURE.entrypoint, ...metadataArgs()]);
			const fileArgs = declaredFiles(WINDOWS_X64_FIXTURE).flatMap((file) => ["--file", file]);
			const explicit = runArtifactManifestCli([
				"--root",
				root,
				"--entrypoint",
				WINDOWS_X64_FIXTURE.entrypoint,
				...metadataArgs(),
				...fileArgs,
			]);
			expect(enumerated.exitCode).toBe(ARTIFACT_MANIFEST_CLI_OK);
			expect(enumerated.stdout).toBe(explicit.stdout);
		} finally {
			cleanup();
		}
	});

	test("--out writes the manifest to disk", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const out = join(root, "manifest.json");
			const result = runArtifactManifestCli(["--root", root, "--entrypoint", WINDOWS_X64_FIXTURE.entrypoint, ...metadataArgs(), "--out", out]);
			expect(result.exitCode).toBe(ARTIFACT_MANIFEST_CLI_OK);
			// The written file excludes itself: it was created after enumeration ran.
			const written = readFileSync(out, "utf8");
			expect(written.endsWith("\n")).toBe(true);
			expect(JSON.parse(written).files.some((entry: { path: string }) => entry.path === "manifest.json")).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("rejection exits 1 with a compact [code] line on stderr", () => {
		const result = runArtifactManifestCli([
			"--root",
			join(WINDOWS_X64_FIXTURE.name, "absent-xyz"),
			"--entrypoint",
			"x.js",
			"--file",
			"x.js",
			...metadataArgs(),
		]);
		expect(result.exitCode).toBe(ARTIFACT_MANIFEST_CLI_REJECTED);
		expect(result.stderr).toContain("[missing]");
	});

	test("usage errors exit 2", () => {
		const missingFlag = runArtifactManifestCli(["--root", "somewhere"]);
		expect(missingFlag.exitCode).toBe(ARTIFACT_MANIFEST_CLI_USAGE);
		expect(missingFlag.stderr).toContain("[usage]");

		const badOs = runArtifactManifestCli([
			"--root",
			"somewhere",
			"--entrypoint",
			"x.js",
			"--host-version",
			"1",
			"--protocol-version",
			"2",
			"--bun-version",
			"1",
			"--os",
			"plan9",
			"--arch",
			"x64",
		]);
		expect(badOs.exitCode).toBe(ARTIFACT_MANIFEST_CLI_USAGE);

		expect(runArtifactManifestCli(["--frobnicate"]).exitCode).toBe(ARTIFACT_MANIFEST_CLI_USAGE);
	});
});
