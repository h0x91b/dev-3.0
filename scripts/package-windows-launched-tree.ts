/**
 * Turns the tree the launch proof actually spawned into the ONE file a Windows human can
 * open, and stages it beside the update tarball for publication.
 *
 * WHY A SECOND FILE AT ALL. `canary-win-x64-dev-3.0-canary.tar.zst` is what the in-app
 * updater downloads, and Windows `tar.exe` cannot read zstd — the bundle ships electrobun's
 * `zig-zstd.exe` precisely because of that. So the archive that serves updates is unopenable
 * to somebody who does not have the app yet, and a channel with no first install is a channel
 * nobody can join. A `.zip` is the one container Explorer extracts with nothing installed.
 *
 * WHY IT IS BUILT FROM THE PROOF AND NOT FROM THE ARCHIVE. The rule this file exists to keep
 * is decisions/2026/08/06/downloadable-windows-build-is-the-launched-tree.md: the bytes handed
 * to a human must be bytes something actually launched. Re-extracting the same `.tar.zst`
 * would produce an equal-looking tree that nothing ever started, and would read identically
 * in the log. So the source directory is read OUT of `windows-app-launch-proof.json`
 * (`retainedUnpackDir`), and the launcher named there must exist inside it before anything is
 * compressed. This script structurally cannot zip a tree no proof ran.
 *
 * The self-extracting `dev-3.0-Setup-canary.exe` the build also produces is NOT published
 * here. Nothing has ever launched it — a known gap, not a rejected idea; see the same record.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUCKET_BASE = "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0";

type LaunchProof = {
	retainedUnpackDir?: unknown;
	bundleRoot?: unknown;
	desktopExecutableRelativePath?: unknown;
};

function fail(message: string): never {
	console.error(`::error::${message}`);
	process.exit(1);
}

function requireString(proof: LaunchProof, field: keyof LaunchProof, why: string): string {
	const value = proof[field];
	if (typeof value !== "string" || !value) {
		fail(`the Windows launch proof carries no \`${field}\`, so ${why}. Fix: run \`bun run verify:win-app-launch\` with DEV3_WINDOWS_APP_UNPACK_DIR set before this step — without that variable the proof extracts into a temp workspace it deletes, and there is no launched tree left to publish.`);
	}
	return value;
}

/**
 * `ZipFile.CreateFromDirectory`, not `Compress-Archive`: the tree is ~400 MB across thousands
 * of files and the cmdlet takes minutes on it, inside a job with a 35-minute budget.
 * `includeBaseDirectory: false` keeps the bundle root (`dev-3.0-canary/`) as the zip's single
 * top-level entry, because that root is already the unpack dir's only child — so extracting
 * gives one folder, not a hundred loose files in Downloads.
 */
function zipDirectory(sourceDir: string, destinationZip: string): void {
	const script = [
		"Add-Type -AssemblyName System.IO.Compression.FileSystem;",
		"[System.IO.Compression.ZipFile]::CreateFromDirectory(",
		`  '${sourceDir.replaceAll("'", "''")}',`,
		`  '${destinationZip.replaceAll("'", "''")}',`,
		"  [System.IO.Compression.CompressionLevel]::Optimal,",
		"  $false)",
	].join("\n");

	const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
	});
	if (result.error) fail(`powershell could not be run to build the zip: ${result.error.message}`);
	if (result.status !== 0) {
		fail(`zipping the launched tree failed (powershell exited ${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
	}
}

const channel = process.env.DEV3_RELEASE_CHANNEL;
const arch = process.env.DEV3_RELEASE_ARCH;
if (channel !== "stable" && channel !== "canary") {
	fail(`DEV3_RELEASE_CHANNEL must be stable or canary, got '${channel ?? ""}'. It prefixes the published file name, so guessing it would publish one channel's build under the other channel's name.`);
}
if (!arch) fail("DEV3_RELEASE_ARCH is unset, so the published file name would be missing its architecture");

const repoRoot = resolve(import.meta.dirname, "..");
const proofPath = resolve(process.env.DEV3_WINDOWS_LAUNCH_PROOF ?? join(repoRoot, "artifacts", "windows-app-launch-proof.json"));
if (!existsSync(proofPath)) {
	fail(`no Windows launch proof at ${proofPath}. This step must run AFTER \`bun run verify:win-app-launch\` and BEFORE create-release-artifacts.sh, which deletes ./artifacts.`);
}

let proof: LaunchProof;
try {
	proof = JSON.parse(readFileSync(proofPath, "utf8")) as LaunchProof;
} catch (error) {
	fail(`the Windows launch proof at ${proofPath} is not valid JSON (${String(error)}), so the launched tree cannot be identified`);
}

const unpackDir = resolve(requireString(proof, "retainedUnpackDir", "the directory the proof launched from is unknown"));
const bundleRoot = requireString(proof, "bundleRoot", "the bundle folder inside it is unknown");
const launcherRelative = requireString(proof, "desktopExecutableRelativePath", "the executable it started is unknown");

const launcherPath = join(unpackDir, bundleRoot, ...launcherRelative.split("/"));
if (!existsSync(launcherPath)) {
	fail(`the launch proof names ${launcherRelative} inside ${bundleRoot}, but ${launcherPath} does not exist. The retained tree was moved or cleaned between the proof and this step, so what would be published is not what launched. Fix: keep DEV3_WINDOWS_APP_UNPACK_DIR untouched between the two steps.`);
}

const outputDir = resolve(join(repoRoot, `artifacts-win-${arch}`));
mkdirSync(outputDir, { recursive: true });
// Named off `bundleRoot` rather than recomputed from the channel: the name then cannot
// disagree with the bytes, and it lines up with electrobun's own
// `canary-win-x64-dev-3.0-canary.tar.zst` without a second copy of the suffix rule.
const zipName = `${channel}-win-${arch}-${bundleRoot}.zip`;
const zipPath = join(outputDir, zipName);

console.log(`Zipping the launched tree: ${unpackDir} -> ${zipPath}`);
zipDirectory(unpackDir, zipPath);
const zipBytes = statSync(zipPath).size;
console.log(`Staged ${zipName} (${(zipBytes / 1024 / 1024).toFixed(1)} MB)`);

// The download instructions live with the artifact, not in a wiki. The SmartScreen paragraph
// is not decoration: a canary user who meets an unexplained "Windows protected your PC"
// dialog concludes the app is malware, and there is no certificate coming.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
	appendFileSync(
		summaryPath,
		[
			"",
			"## Windows canary build",
			"",
			`**Download:** ${BUCKET_BASE}/${zipName} (${(zipBytes / 1024 / 1024).toFixed(1)} MB)`,
			"",
			`1. Download the \`.zip\`, right-click it → **Extract All**. No other tool is needed.`,
			`2. Open the extracted \`${bundleRoot}\` folder and double-click \`${launcherRelative}\`.`,
			// MEASURED, not predicted, on a real ru-RU Windows machine: the buttons were
			// «Подробнее» then «Всё равно запустить» — two clicks, and the app ran normally
			// afterwards. The title line is deliberately NOT quoted here: it is localised, and
			// nobody has read the en-US one.
			`3. **This build is not code-signed, and it never will be.** Windows blanks the screen with a blue SmartScreen warning the first time you run it. Getting past it is two clicks: **More info**, then **Run anyway**. This is Windows telling you it does not recognise the publisher — not a virus report.`,
			"",
			`These are the exact bytes the launch proof spawned in this run — bundle root \`${bundleRoot}\`, entry point \`${launcherRelative}\`.`,
			"",
		].join("\n"),
	);
}
