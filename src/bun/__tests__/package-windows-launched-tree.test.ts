/**
 * The zip a Windows human downloads must be the tree something launched.
 *
 * These assertions are all REFUSALS, and that is not a gap in coverage — it is where the whole
 * risk lives. Zipping works or it does not, loudly. The failure this file guards is the quiet
 * one: a zip built from an equal-looking re-extraction of the same archive, which nothing ever
 * started, and which reads identically in the log to the real thing. Every branch below is a
 * way that could happen.
 *
 * The compression itself is not asserted here: it goes through PowerShell's
 * System.IO.Compression, which does not exist on the host running this suite. It is covered by
 * the Windows job, where the produced zip is the published artifact.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../scripts/package-windows-launched-tree.ts",
);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(proof: unknown | null, env: Record<string, string> = {}) {
	const tempDir = mkdtempSync(join(tmpdir(), "dev3-win-tree-"));
	tempDirs.push(tempDir);
	const proofPath = join(tempDir, "launch-proof.json");
	if (proof !== null) writeFileSync(proofPath, JSON.stringify(proof));

	const result = spawnSync("bun", [SCRIPT_PATH], {
		encoding: "utf8",
		env: {
			...process.env,
			DEV3_RELEASE_CHANNEL: "canary",
			DEV3_RELEASE_ARCH: "x64",
			DEV3_WINDOWS_LAUNCH_PROOF: proofPath,
			...env,
		},
	});
	return { ...result, output: `${result.stdout}${result.stderr}`, tempDir };
}

describe("packaging the launched Windows tree", () => {
	it("refuses a proof with no retained unpack dir, instead of re-extracting the archive", () => {
		const result = run({ bundleRoot: "dev-3.0-canary", desktopExecutableRelativePath: "bin/launcher.exe" });

		expect(result.status, "a proof without `retainedUnpackDir` means the launch happened in a temp workspace that is already deleted. There is no launched tree left, and the only way to produce a zip anyway is to re-extract the archive — a look-alike nothing ran.").not.toBe(0);
		expect(result.output).toMatch(/retainedUnpackDir/);
		expect(
			result.output,
			"the failure must name the fix, because the cause is one missing environment variable two steps earlier and nothing else points at it.",
		).toMatch(/DEV3_WINDOWS_APP_UNPACK_DIR/);
	});

	it("refuses when the tree no longer holds the executable the proof launched", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-win-unpack-"));
		tempDirs.push(tempDir);
		// The bundle root exists, so the directory looks entirely plausible — it just does not
		// contain the launcher any more, which is what a cleanup step between the two jobs
		// leaves behind.
		mkdirSync(join(tempDir, "dev-3.0-canary", "bin"), { recursive: true });

		const result = run({
			retainedUnpackDir: tempDir,
			bundleRoot: "dev-3.0-canary",
			desktopExecutableRelativePath: "bin/launcher.exe",
		});

		expect(result.status, "the tree must be verified against the proof, not trusted because the directory exists. A tree missing its launcher zips into a download that cannot start.").not.toBe(0);
		expect(result.output).toMatch(/bin\/launcher\.exe/);
	});

	it("refuses a missing proof by naming the step ordering that causes it", () => {
		const result = run(null);

		expect(result.status).not.toBe(0);
		expect(
			result.output,
			"the ordering IS the bug: create-release-artifacts.sh deletes ./artifacts, so running this after it finds no proof. The error has to say so or the next reader debugs the proof instead of the order.",
		).toMatch(/create-release-artifacts\.sh/);
	});

	it("refuses to guess the channel it is publishing under", () => {
		const result = run(
			{ retainedUnpackDir: "/nope", bundleRoot: "dev-3.0-canary", desktopExecutableRelativePath: "bin/launcher.exe" },
			{ DEV3_RELEASE_CHANNEL: "" },
		);

		expect(result.status, "the channel prefixes the published file name. Defaulting it would publish a canary build under the stable name, where ordinary users' apps would find it.").not.toBe(0);
		expect(result.output).toMatch(/DEV3_RELEASE_CHANNEL/);
	});

	it("rejects a channel it does not publish, the same way the artifact script does", () => {
		const result = run(
			{ retainedUnpackDir: "/nope", bundleRoot: "dev-3.0-canary", desktopExecutableRelativePath: "bin/launcher.exe" },
			{ DEV3_RELEASE_CHANNEL: "unstable" },
		);

		expect(result.status, "`unstable` is this channel's PREVIOUS name, so it is exactly what a stale caller passes. It must fail here as loudly as it does in create-release-artifacts.sh.").not.toBe(0);
	});
});
