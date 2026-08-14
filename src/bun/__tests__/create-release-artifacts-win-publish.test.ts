/**
 * THE CANARY VERSION SUFFIX, EXECUTED ON WHATEVER RUNNER THIS FILE IS ON.
 *
 * This file exists because a sibling test in `create-release-artifacts.test.ts` already
 * ran `publish_version()` with `channel=canary` and passed — on macOS. The first real
 * `build-win-x64` job then died inside that same function (canary-publish run 31789301294,
 * job 94733263647):
 *
 *   error: Cannot find module '/d/a/dev-3.0/dev-3.0/src/shared/update-channel.ts'
 *          from 'D:\a\dev-3.0\dev-3.0\[eval]'
 *
 * Git Bash's `pwd` speaks MSYS (`/d/a/...`), bun on Windows resolves only `D:\a\...`. Both
 * dialects are in that one line. A POSIX runner cannot see this class of bug AT ALL, because
 * there the two dialects are the same string — so the assertion has to be executed on
 * Windows, not asserted about it. `windows-conpty-package.yml` runs this file on
 * windows-latest, macOS and Linux, and that job gates every publisher.
 *
 * Kept out of `create-release-artifacts.test.ts` on purpose: the tests there stage
 * `zig-zstd` shell shims named `.exe` and lean on `tar`, neither of which survives a Windows
 * runner. This one needs only bash, bun and git, so a red result here is the real defect
 * rather than a shim.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// Forward slashes, because Git Bash is the shell on the Windows runner and this string is
// argv[1] of `bash`. A native `D:\a\...` would arrive with its separators intact but reads
// as escapes the moment anything in the script re-parses it.
const SCRIPT_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../scripts/create-release-artifacts.sh",
).replaceAll("\\", "/");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("create-release-artifacts.sh publish_version, on this platform", () => {
	// CASE 1 — electrobun produced its own ./artifacts, which is exactly what the real
	// win-x64 job takes. No tar, no zstd, no bundle layout: the only thing under test is the
	// bun round trip that stamps the canary suffix.
	function stageCase1AndRun(channel: "stable" | "canary") {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-win-publish-"));
		tempDirs.push(tempDir);

		// A real git repo: BUILD_SHA falls back to the literal "unknown" outside one, and the
		// suffix would then be asserted on a string no build ever produces.
		const gitEnv = {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		};
		for (const args of [["init"], ["commit", "--allow-empty", "-m", "seed"]]) {
			spawnSync("git", args, { cwd: tempDir, encoding: "utf8", env: gitEnv });
		}
		const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).stdout.trim();

		const appFileName = channel === "stable" ? "dev-3.0" : "dev-3.0-canary";
		mkdirSync(join(tempDir, "artifacts"), { recursive: true });
		// Contents are never read — the script only copies this file — so opaque bytes are
		// honest here and keep the test off zstd entirely.
		writeFileSync(join(tempDir, "artifacts", `${appFileName}.tar.zst`), "not really zstd");
		writeFileSync(
			join(tempDir, "artifacts", `${channel}-win-x64-update.json`),
			JSON.stringify({ version: "1.44.0", hash: "3r8kx81pg91jh", channel }),
		);

		const result = spawnSync("bash", [SCRIPT_PATH, "win", "x64", channel], { cwd: tempDir, encoding: "utf8" });
		const manifestPath = join(tempDir, "artifacts-win-x64", `${channel}-win-x64-update.json`);
		return {
			result,
			sha,
			output: `${result.stdout}${result.stderr}`,
			manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string; os: string },
		};
	}

	it(`stamps the canary suffix on ${process.platform}, where the shell and bun may disagree about paths`, () => {
		const canary = stageCase1AndRun("canary");

		expect(
			canary.output,
			"`Cannot find module` here is THE Windows defect: publish_version handed bun a path in the shell's dialect. Fix: never interpolate an absolute path into `bun -e` — cd to the repo root in a subshell and import relative to the cwd, which both dialects agree on.",
		).not.toMatch(/Cannot find module/);
		expect(canary.result.status, `the canary run must succeed. Output:\n${canary.output}`).toBe(0);
		expect(
			canary.manifest.version,
			"the published canary manifest must carry `+canary.<short-sha>`. Without it the update popover offers a build off main under the last stable release's name.",
		).toBe(`1.44.0+canary.${canary.sha.slice(0, 8)}`);
		expect(canary.manifest.os, "the manifest key the in-app updater fetches is `win`, never `windows`.").toBe("win");
	});

	// The control run. Without it a publish_version() that always returned its input would
	// satisfy nothing above and still look like a pass on the stable feed.
	it("leaves the stable manifest's version exactly as the bundle reports it", () => {
		const stable = stageCase1AndRun("stable");
		expect(stable.result.status, `the stable run must succeed. Output:\n${stable.output}`).toBe(0);
		expect(
			stable.manifest.version,
			"stable must publish the bundle version untouched — a suffix here reads to every stable client as a permanent phantom downgrade.",
		).toBe("1.44.0");
	});
});
