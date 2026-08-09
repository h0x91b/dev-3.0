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

		// `unstable` on purpose: it is the name this channel USED to have, so it is the exact
		// string a stale caller, an old workflow copy or a half-applied rename would pass.
		const result = spawnSync("bash", [SCRIPT_PATH, "macos", "arm64", "unstable"], { cwd: tempDir, encoding: "utf8" });

		expect(
			result.status,
			"an unknown channel must fail. Otherwise the script happily writes `unstable-macos-arm64-*` artifacts that no client ever asks for — and since that was this channel's previous name, a caller left behind by the rename would publish into a feed nobody polls, with the run green.",
		).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toMatch(/unknown channel 'unstable'/);
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
			JSON.stringify({ version: "9.9.9", hash: "deadbeef", channel: "stable" }),
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
		// The staging copy happens BEFORE the last checks in the script, so asserting the
		// artifact exists is not the same as asserting the script succeeded. It has to be
		// both, or a script that stages and then fails reads as a pass.
		expect(
			result.status,
			"the whole recovery path must EXIT 0, not merely produce the tarball. Staging happens before the script's final checks, so a non-zero exit here means something after the copy rejected the build — read the stderr above rather than trusting the artifact's existence.",
		).toBe(0);
	});

	// THE CANARY VERSION SUFFIX, ASSERTED ON THE FILE THIS SCRIPT WRITES.
	//
	// `canaryDisplayVersion()` shipped with a passing unit test and ZERO production callers,
	// so every published canary manifest carried a bare `1.42.3` and told the user a build
	// off main was the stable release. A unit test on the helper cannot see that — it is the
	// same shape as the three guards that asserted a vendored patch nobody executed. So this
	// runs the script and reads the manifest, and the control run in the same test is what
	// proves the suffix is canary-only rather than always-on.
	function stageBundleAndRun(channel: "stable" | "canary") {
		const tempDir = mkdtempSync(join(tmpdir(), "dev3-release-artifacts-"));
		tempDirs.push(tempDir);
		// A real git repo: BUILD_SHA falls back to the literal "unknown" outside one, which
		// would make the suffix assertion pass on a string no build ever produces.
		for (const args of [["init"], ["commit", "--allow-empty", "-m", "seed"]]) {
			spawnSync("git", args, {
				cwd: tempDir,
				encoding: "utf8",
				env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
			});
		}
		const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).stdout.trim();

		const buildDir = join(tempDir, "build", `${channel}-linux-x64`);
		const bundleName = channel === "stable" ? "dev-3.0" : "dev-3.0-canary";
		mkdirSync(join(buildDir, bundleName, "resources"), { recursive: true });
		const versionJson = join(buildDir, bundleName, "resources", "version.json");
		writeFileSync(versionJson, JSON.stringify({ version: "1.42.3", hash: "bundlehash", channel }));
		spawnSync("tar", ["-cf", join(buildDir, `${bundleName}.tar`), "-C", buildDir, bundleName], { encoding: "utf8" });
		// Only a .tar, so the script compresses it itself. Stand-in for zig-zstd, which is
		// only installed for the host's own platform (see the sibling test above).
		const zstdDir = join(tempDir, "node_modules", "electrobun", "dist-linux-x64");
		mkdirSync(zstdDir, { recursive: true });
		writeFileSync(join(zstdDir, "zig-zstd"), '#!/bin/sh\ncp "$3" "$5"\n', { mode: 0o755 });

		const result = spawnSync("bash", [SCRIPT_PATH, "linux", "x64", channel], { cwd: tempDir, encoding: "utf8" });
		const manifestPath = join(tempDir, "artifacts-linux-x64", `${channel}-linux-x64-update.json`);
		return {
			result,
			sha,
			output: `${result.stdout}${result.stderr}`,
			manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null,
			recoveredVersionJson: join(buildDir, "recovered", bundleName, "resources", "version.json"),
		};
	}

	it("publishes the canary build under a version that says it is a canary build", () => {
		const canary = stageBundleAndRun("canary");
		expect(canary.result.status, `the canary run must succeed. Output:\n${canary.output}`).toBe(0);
		expect(
			canary.manifest?.version,
			"the PUBLISHED canary manifest must carry the +canary.<short-sha> suffix. A bare version here is the defect this test exists for: the update popover then offers `v1.42.3 ready to install` with `what's new in v1.42.3` for a build off main, naming a stable release the user is not being given. Fix: keep publish_version() wired into both update.json writes — canaryDisplayVersion() having a green unit test proves nothing about the file.",
		).toBe(`1.42.3+canary.${canary.sha.slice(0, 8)}`);
		expect(
			JSON.parse(readFileSync(canary.recoveredVersionJson, "utf8")).version,
			"the BUNDLE's version.json must stay bare. `dev3 doctor` compares it against the CLI version by string equality, so a suffix in here reports a spurious CLI/app mismatch on every canary install.",
		).toBe("1.42.3");
	});

	it("leaves the stable manifest's version exactly as the bundle reports it", () => {
		const stable = stageBundleAndRun("stable");
		expect(stable.result.status, `the stable run must succeed. Output:\n${stable.output}`).toBe(0);
		expect(
			stable.manifest?.version,
			"stable must publish the bundle version untouched. If this ever grows a suffix, every stable client compares a version whose patch component semver silently reads as 0 — they would be offered a permanent phantom downgrade.",
		).toBe("1.42.3");
	});

	// Both fields land in the manifest this script is the single writer of. They answer
	// different questions: sha says WHICH COMMIT (the hourly workflow's skip check),
	// buildOrder says WHICH BUILD IS NEWER (canary clients' ordering).
	it("writes both manifest identity fields, not one derived from the other", () => {
		const script = readFileSync(SCRIPT_PATH, "utf8");
		expect(
			script,
			"the published manifest must carry `sha`. Without it the hourly canary workflow has nothing to compare against main and would rebuild every hour forever.",
		).toMatch(/\\"sha\\":/);
		expect(
			script,
			"the published manifest must carry `buildOrder`. Without it decideUpdate() reports an error on the canary channel and no canary client can ever update.",
		).toMatch(/\\"buildOrder\\":/);
		expect(
			script,
			"buildOrder must come from `git rev-list --count HEAD` — monotonic only because main is squash-merged (linear history, +1 per merge) — a property of how this repo lands PRs, not of git. Fix: keep the command, and if main ever takes merge commits the canary ordering has to change with it.",
		).toMatch(/git rev-list --count HEAD/);
	});
});
