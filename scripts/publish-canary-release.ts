/**
 * Refreshes the rolling `canary` GitHub pre-release from the artifacts of one canary run.
 *
 * Thin on purpose, like decide-canary-publish.ts: every rule lives in
 * `src/shared/canary-release.ts` where it is unit tested, and this file only does the I/O —
 * read the downloaded artifacts, move the tag, create-or-edit the release, upload the files.
 *
 * PRERELEASE AND NOT-LATEST ARE ASSERTED ON BOTH PATHS, create and edit. GitHub keeps
 * `/releases/latest` off prereleases, and that URL is load-bearing in two places outside CI:
 * `src/bun/rosetta.ts` hands it to a user on the wrong architecture, and the landing page's
 * download buttons point at it. A canary release that ever became Latest would send every
 * casual visitor an unsigned build of whatever main was at.
 *
 * PARTIAL RUNS ARE NORMAL. Each platform is skipped independently, so a run may carry only a
 * Windows zip; the ledger merge keeps the other platforms' rows and their real provenance
 * instead of letting the body claim they came from this run.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	CANARY_LEDGER_ASSET,
	CANARY_RELEASE_TAG,
	classifyCanaryArtifact,
	mergeCanaryLedger,
	parseCanaryLedger,
	platformOfArtifact,
	renderCanaryReleaseBody,
	type CanaryAssetEntry,
} from "../src/shared/canary-release";

const artifactDir = process.env.DEV3_CANARY_ARTIFACT_DIR ?? "all-artifacts";
const repo = process.env.GITHUB_REPOSITORY ?? "";
const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const runId = process.env.GITHUB_RUN_ID ?? "";
const sha = process.env.GITHUB_SHA ?? "";

for (const [name, value] of Object.entries({ GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_SHA: sha })) {
	if (!value) {
		console.error(`::error::${name} is unset, so the release cannot say which run produced these bytes`);
		process.exit(1);
	}
}

const repoUrl = `${serverUrl}/${repo}`;

/** One `gh` invocation. Never throws on a non-zero exit — callers decide what a failure means. */
function gh(args: string[], stdin?: string) {
	const result = spawnSync("gh", args, { encoding: "utf8", input: stdin });
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim() || `gh exited ${result.status}`,
	};
}

function ghOrDie(args: string[], what: string) {
	const result = gh(args);
	if (!result.ok) {
		console.error(`::error::${what} failed: ${result.stderr}`);
		process.exit(1);
	}
	return result.stdout;
}

// ── What this run actually built ────────────────────────────────────────────
let names: string[];
try {
	names = readdirSync(artifactDir).filter((name) => statSync(join(artifactDir, name)).isFile());
} catch (err) {
	console.error(`::error::${artifactDir} could not be read (${String(err)}). The job downloads the build artifacts into it, so an empty run should have been skipped by the job's \`if:\` rather than reaching this script.`);
	process.exit(1);
}

const uploads: string[] = [];
for (const name of names.sort()) {
	const verdict = classifyCanaryArtifact(name);
	if (verdict.upload) uploads.push(name);
	else console.log(`skip ${name} — ${verdict.reason}`);
}

if (uploads.length === 0) {
	console.error("::error::this run produced no downloadable artifact, so refreshing the release would only rewrite its body. Fix: check the build jobs — the release job is gated on at least one of them succeeding.");
	process.exit(1);
}

/**
 * The version comes out of THIS run's own manifest rather than package.json: the manifest is
 * what the publisher wrote (`1.44.0+canary.<sha>`), so the title cannot drift from the build.
 */
const manifest = names.find((name) => name.endsWith("-update.json"));
if (!manifest) {
	console.error("::error::no *-update.json among the artifacts, so the canary version cannot be read. Fix: create-release-artifacts.sh writes one per platform — check the build job's artifact upload.");
	process.exit(1);
}
const version = (JSON.parse(readFileSync(join(artifactDir, manifest), "utf8")) as { version?: string }).version;
if (!version) {
	console.error(`::error::${manifest} carries no version field, which means a previous publish wrote a broken manifest`);
	process.exit(1);
}

// ── Does the rolling release exist yet? ─────────────────────────────────────
const releaseExists = gh(["release", "view", CANARY_RELEASE_TAG, "--repo", repo, "--json", "tagName"]).ok;

/**
 * The ledger already on the release, if any. A missing or unreadable one is NOT fatal: it
 * degrades to "this run's assets only", which is honest — every row it prints still names the
 * run that produced that file.
 */
let previous = null;
if (releaseExists) {
	const download = gh([
		"release", "download", CANARY_RELEASE_TAG, "--repo", repo,
		"--pattern", CANARY_LEDGER_ASSET, "--output", "-",
	]);
	if (download.ok) previous = parseCanaryLedger(download.stdout);
	if (!previous) {
		console.log(`::warning::no readable ${CANARY_LEDGER_ASSET} on the existing release, so rows for platforms this run did not build are dropped rather than guessed`);
	}
}

const builtAt = new Date().toISOString();
const fresh: CanaryAssetEntry[] = uploads.map((asset) => ({
	asset,
	platform: platformOfArtifact(asset),
	sha,
	runId,
	builtAt,
}));

const ledger = mergeCanaryLedger(previous, fresh);
const ledgerPath = join(artifactDir, CANARY_LEDGER_ASSET);
writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, "\t")}\n`);

const notesPath = join(artifactDir, "canary-release-notes.md");
writeFileSync(notesPath, renderCanaryReleaseBody({ ledger, version, repoUrl, generatedAt: builtAt }));
console.log("=== Release body ===");
console.log(readFileSync(notesPath, "utf8"));

// ── Point the tag at this commit ────────────────────────────────────────────
// `gh release create --target` only creates a tag that does not exist yet; an existing tag
// would keep the release pinned to whatever commit it was first cut from, so the page would
// show an ever-staler source commit while the assets moved on.
if (gh(["api", `repos/${repo}/git/ref/tags/${CANARY_RELEASE_TAG}`]).ok) {
	ghOrDie(
		["api", "-X", "PATCH", `repos/${repo}/git/refs/tags/${CANARY_RELEASE_TAG}`, "-f", `sha=${sha}`, "-F", "force=true"],
		`moving the ${CANARY_RELEASE_TAG} tag to ${sha.slice(0, 9)}`,
	);
	console.log(`Moved tag ${CANARY_RELEASE_TAG} → ${sha.slice(0, 9)}`);
}

// ── Create or refresh the release ───────────────────────────────────────────
if (releaseExists) {
	ghOrDie(
		[
			"release", "edit", CANARY_RELEASE_TAG, "--repo", repo,
			"--title", `Canary ${version}`,
			"--notes-file", notesPath,
			// Re-asserted every run: if anything ever flips these by hand, the next publish puts
			// them back rather than leaving an unsigned build wearing the Latest badge.
			"--prerelease",
			"--latest=false",
		],
		`updating the ${CANARY_RELEASE_TAG} release`,
	);
} else {
	ghOrDie(
		[
			"release", "create", CANARY_RELEASE_TAG, "--repo", repo,
			"--target", sha,
			"--title", `Canary ${version}`,
			"--notes-file", notesPath,
			"--prerelease",
			"--latest=false",
		],
		`creating the ${CANARY_RELEASE_TAG} release`,
	);
}

// ── Attach the files ────────────────────────────────────────────────────────
// `--clobber` because the names are stable by design: one link in the app's own refusal
// message, one link in a bug report, and they keep resolving to the current canary.
for (const asset of [...uploads, CANARY_LEDGER_ASSET]) {
	ghOrDie(
		["release", "upload", CANARY_RELEASE_TAG, join(artifactDir, asset), "--repo", repo, "--clobber"],
		`uploading ${asset}`,
	);
	console.log(`Uploaded ${asset}`);
}

console.log(`::notice::Canary ${version} is on ${repoUrl}/releases/tag/${CANARY_RELEASE_TAG} (pre-release, not Latest) with ${uploads.length} downloadable files`);
