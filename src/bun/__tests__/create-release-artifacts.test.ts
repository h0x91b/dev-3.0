import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";


const SCRIPT_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../scripts/create-release-artifacts.sh",
);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("create-release-artifacts.sh", () => {
	it("surfaces partial macOS app zips as a post-package electrobun failure", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-release-artifacts-"));
		tempDirs.push(tempDir);

		const buildDir = join(tempDir, "build", "stable-macos-arm64");
		mkdirSync(buildDir, { recursive: true });
		writeFileSync(join(buildDir, "dev-3.0.app.zip"), "fake zip");

		const result = spawnSync("bash", [SCRIPT_PATH, "macos", "arm64", "stable"], {
			cwd: tempDir,
			encoding: "utf8",
		});

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Electrobun likely failed after packaging the app");
		expect(result.stdout).toContain("notarization");
		expect(result.stdout).toContain("dev-3.0.app.zip");
		expect(result.stdout).not.toContain("build failed before tarring");
	});

	// The channel is REQUIRED and deliberately not defaulted. It prefixes every artifact
	// name and the update manifest, so a default would let a future caller publish one
	// channel's build into the other channel's feed with every test still green — an
	// omission that reads as a valid choice.
	it("refuses to run without a channel instead of guessing one", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-release-artifacts-"));
		tempDirs.push(tempDir);

		const result = spawnSync("bash", [SCRIPT_PATH, "macos", "arm64"], { cwd: tempDir, encoding: "utf8" });

		expect(
			result.status,
			"the script must FAIL when <channel> is missing. Fix: keep the `${3:?...}` guard in scripts/create-release-artifacts.sh — do not give CHANNEL a default, or an omitted argument silently publishes into the wrong channel's feed.",
		).not.toBe(0);
		expect(
			`${result.stdout}${result.stderr}`,
			"the failure must name the missing argument AND what it prevents, so the caller learns the rule from the error rather than from a decision record.",
		).toMatch(/missing <channel> argument/);
	});

	it("rejects a channel it does not publish, rather than prefixing artifacts with it", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-release-artifacts-"));
		tempDirs.push(tempDir);

		const result = spawnSync("bash", [SCRIPT_PATH, "macos", "arm64", "canary"], { cwd: tempDir, encoding: "utf8" });

		expect(
			result.status,
			"an unknown channel must fail. Otherwise the script happily writes `canary-macos-arm64-*` artifacts that no client ever asks for, and the run goes green.",
		).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toMatch(/unknown channel 'canary'/);
	});


	// THE RECOVERY PATH (Case 2) IS NOT DEAD CODE — it is what ships when electrobun crashes
	// after tarring, which is a real and recurring failure. It is also only reachable when
	// EBUN_TAR_ZST is EMPTY, so a copy-paste that used that variable here produced
	// `cp: : No such file or directory` and the whole path silently stopped working. It was
	// invisible to every other test because the happy path (Case 1) never touches it, and it
	// only surfaced in a real dry run (release.yml run 31098887428, build-macos-x64).
	it("recovers from a tar left in the build dir when electrobun produced no artifacts", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-release-artifacts-"));
		tempDirs.push(tempDir);

		// A build dir holding only the compressed tar: exactly the state electrobun leaves
		// when it dies after tarring. No ./artifacts, so the script takes Case 2.
		const buildDir = join(tempDir, "build", "stable-linux-x64");
		mkdirSync(buildDir, { recursive: true });
		writeFileSync(join(buildDir, "dev-3.0.tar.zst"), "not really zstd");

		const result = spawnSync("bash", [SCRIPT_PATH, "linux", "x64", "stable"], {
			cwd: tempDir,
			encoding: "utf8",
		});
		const output = `${result.stdout}${result.stderr}`;

		expect(
			output,
			"the recovery path must reach the staged tarball copy. `cp: : No such file or directory` means the copy source is EMPTY — the classic symptom of using $EBUN_TAR_ZST here, which is empty by definition in this branch. Fix: copy $TAR_ZST.",
		).not.toMatch(/cp: : No such file/);
		expect(
			output,
			"the recovery path must not be mistaken for the no-tar case; it found a tar.zst.",
		).not.toMatch(/build failed before tarring/);
		// The staged artifact must be named for the channel and the app file name.
		expect(existsSync(join(tempDir, "artifacts-linux-x64", "stable-linux-x64-dev-3.0.tar.zst"))).toBe(true);
	});


	it("names the crash-before-tarring case instead of failing obscurely", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-release-artifacts-"));
		tempDirs.push(tempDir);
		mkdirSync(join(tempDir, "build", "stable-linux-x64"), { recursive: true });

		const result = spawnSync("bash", [SCRIPT_PATH, "linux", "x64", "stable"], { cwd: tempDir, encoding: "utf8" });

		expect(result.status).not.toBe(0);
		expect(
			`${result.stdout}${result.stderr}`,
			"an empty build dir must say the build failed BEFORE tarring. Without that the operator sees a bare cp/find error and starts debugging this script instead of the build above it.",
		).toMatch(/build failed before tarring/);
	});

	// TWO failure-only paths at once, and both were dead.
	//  1. electrobun can die between writing the tar and compressing it, leaving a .tar with
	//     no .tar.zst — this branch compresses it itself. It called `zig-zstd <in> -o <out>`,
	//     but that binary REQUIRES `compress -i <in>`, so it exited `error: InvalidArgs`.
	//     Dead since PR #12 (2026-03-01) and never noticed, because only a crash reaches it.
	//  2. version.json not at the expected bundle path — the `find` fallback. Exercised here
	//     by tarring a directory that is not the .app bundle, which also keeps the test fast
	//     by skipping DMG creation (hdiutil alone blows the default 5s timeout).
	it("compresses a tar the build left uncompressed, finding version.json off the expected path", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-release-artifacts-"));
		tempDirs.push(tempDir);
		const buildDir = join(tempDir, "build", "stable-macos-arm64");
		mkdirSync(join(buildDir, "payload", "Contents", "Resources"), { recursive: true });
		writeFileSync(
			join(buildDir, "payload", "Contents", "Resources", "version.json"),
			JSON.stringify({ version: "9.9.9", hash: "deadbeef" }),
		);
		// A REAL tar (the script untars it to recover version.json) and deliberately no .zst.
		spawnSync("tar", ["-cf", join(buildDir, "dev-3.0.app.tar"), "-C", buildDir, "payload"], { encoding: "utf8" });
		// A STAND-IN for zig-zstd that enforces its real contract, rather than the installed
		// binary: `dist-macos-arm64/` only exists on a macOS arm64 install, so symlinking the
		// repo's node_modules made this pass on the author's laptop and fail on a Linux CI
		// runner with a misleading assertion. The shim refuses positional arguments exactly
		// as the real binary does, so the InvalidArgs assertion below keeps its teeth.
		const zstdDir = join(tempDir, "node_modules", "electrobun", "dist-macos-arm64");
		mkdirSync(zstdDir, { recursive: true });
		writeFileSync(
			join(zstdDir, "zig-zstd"),
			[
				"#!/bin/sh",
				'[ "$1" = "compress" ] || { echo "error: InvalidArgs"; exit 1; }',
				"shift",
				'IN=""; OUT=""',
				'while [ $# -gt 0 ]; do',
				'  case "$1" in',
				'    -i) IN="$2"; shift 2 ;;',
				'    -o) OUT="$2"; shift 2 ;;',
				'    --*) shift ;;',
				'    *) echo "error: InvalidArgs"; exit 1 ;;',
				"  esac",
				"done",
				'[ -n "$IN" ] && [ -n "$OUT" ] || { echo "error: InvalidArgs"; exit 1; }',
				'cp "$IN" "$OUT"',
			].join("\n"),
			{ mode: 0o755 },
		);

		const result = spawnSync("bash", [SCRIPT_PATH, "macos", "arm64", "stable"], { cwd: tempDir, encoding: "utf8" });
		const output = `${result.stdout}${result.stderr}`;

		expect(
			output,
			"zig-zstd must be called as `compress -i <in> -o <out>`. `error: InvalidArgs` means it was called positionally, which leaves the uncompressed-tar recovery branch dead.",
		).not.toMatch(/InvalidArgs/);
		expect(
			output,
			"the fallback must report WHERE it found version.json, so a bundle-layout change is visible in the log instead of silently working.",
		).toMatch(/version\.json found at unexpected path/);
		expect(
			existsSync(join(tempDir, "artifacts-macos-arm64", "stable-macos-arm64-dev-3.0.app.tar.zst")),
			"the compressed tarball must be staged from a build that only produced the uncompressed tar.",
		).toBe(true);
		// Staging happens BEFORE the script's remaining work, so asserting the artifact exists
		// is NOT the same as asserting the script succeeded — and that gap is how the
		// version.json fallback stayed broken while this test passed.
		expect(
			result.status,
			"the whole recovery path must EXIT 0, not merely produce the tarball. A non-zero exit means something after the staging copy rejected the build; read the output above rather than trusting the artifact's existence.",
		).toBe(0);
	});

	// Both fields land in the manifest this script is the single writer of. They answer
	// different questions: sha says WHICH COMMIT (the hourly workflow's skip check),
	// buildOrder says WHICH BUILD IS NEWER (unstable clients' ordering).
	it("writes both manifest identity fields, not one derived from the other", () => {
		const script = readFileSync(SCRIPT_PATH, "utf8");
		expect(
			script,
			"the published manifest must carry `sha`. Without it the hourly unstable workflow has nothing to compare against main and would rebuild every hour forever.",
		).toMatch(/\\"sha\\":/);
		expect(
			script,
			"the published manifest must carry `buildOrder`. Without it decideUpdate() reports an error on the unstable channel and no unstable client can ever update.",
		).toMatch(/\\"buildOrder\\":/);
		expect(
			script,
			"buildOrder must come from `git rev-list --count HEAD` — monotonic only because main is squash-merged (linear history, +1 per merge) — a property of how this repo lands PRs, not of git. Fix: keep the command, and if main ever takes merge commits the unstable ordering has to change with it.",
		).toMatch(/git rev-list --count HEAD/);
	});
});
