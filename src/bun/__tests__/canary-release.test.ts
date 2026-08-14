/**
 * The rolling `canary` GitHub pre-release: what it may hand out, what it must never become,
 * and what the release body has to say.
 *
 * TWO FAILURES ARE SILENT AND EXPENSIVE, and everything here exists for one of them:
 *   1. The canary release becoming "Latest". `/releases/latest` is fetched by
 *      src/bun/rosetta.ts and linked by every download button on docs/index.html, so a canary
 *      wearing that badge sends unsigned builds of whatever main was at to casual visitors —
 *      with nothing red anywhere.
 *   2. The tag matching release.yml's filters. That workflow fires on `v*` and `test-*`; a
 *      canary tag inside either glob would start a full stable release on every publish,
 *      including the Homebrew cask edit.
 *
 * Scope follows the property: the pure rules are asserted against the module, the shell
 * decisions against the script that makes them, and the job wiring against the workflow.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANARY_PLATFORMS } from "../../shared/canary-publish";
import {
	CANARY_LEDGER_ASSET,
	CANARY_RELEASE_TAG,
	classifyCanaryArtifact,
	mergeCanaryLedger,
	parseCanaryLedger,
	platformOfArtifact,
	renderCanaryReleaseBody,
	type CanaryAssetEntry,
} from "../../shared/canary-release";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const CANARY_WORKFLOW = read("../../../.github/workflows/canary-publish.yml");
const RELEASE_WORKFLOW = read("../../../.github/workflows/release.yml");
const SCRIPT = read("../../../scripts/publish-canary-release.ts");

const entry = (over: Partial<CanaryAssetEntry> = {}): CanaryAssetEntry => ({
	asset: "canary-win-x64-dev-3.0-canary.zip",
	platform: "win-x64",
	sha: "42ee05e82f0b1c9d8e7a6b5c4d3e2f1a09876543",
	runId: "31300000001",
	builtAt: "2026-08-14T12:00:00.000Z",
	...over,
});

describe("what may be attached to the canary release", () => {
	it("hands out the builds a person installs", () => {
		for (const name of [
			"canary-win-x64-dev-3.0-canary.zip",
			"canary-macos-arm64-dev-3.0.dmg",
			"canary-linux-x64-dev-3.0.tar.zst",
			"dev3-cli-macos-arm64.tar.gz",
		]) {
			expect(classifyCanaryArtifact(name), `${name} is a file a human installs and must be attached`).toEqual({
				upload: true,
			});
		}
	});

	// The manifest is how EVERY client discovers builds. A copy pinned to a release goes stale
	// the moment the next publish overwrites the bucket, and then two files with the same name
	// disagree about which build is current — with the wrong one served from the page a human
	// was pointed at.
	it("never attaches an update manifest, which would read as a second feed", () => {
		const verdict = classifyCanaryArtifact("canary-win-x64-update.json");
		expect(
			verdict.upload,
			"an *-update.json is being attached to the release. The app discovers builds through the S3 feed only; a copy on the release page is a second feed that is stale as soon as the next build publishes. Fix: keep the *-update.json rejection in classifyCanaryArtifact.",
		).toBe(false);
	});

	// The one rule copied deliberately from release.yml, because the reason is the same on both
	// surfaces: nothing has ever launched the installer, so handing it out would put the
	// unvetted binary in front of users while the proven zip stayed decoration.
	it("never attaches the Windows installer nothing has ever launched", () => {
		const verdict = classifyCanaryArtifact("canary-win-x64-dev-3.0-canary-Setup-canary.zip");
		expect(
			verdict.upload,
			"the self-extracting Windows installer is being attached. No job, test or proof has ever launched it — the launch proof spawns the tree inside the plain zip. Fix: keep the Setup rejection in classifyCanaryArtifact and grow verify:win-app-launch a second target before publishing it.",
		).toBe(false);
	});

	it("never attaches the zstd tarball Windows cannot open", () => {
		expect(
			classifyCanaryArtifact("canary-win-x64-dev-3.0-canary.tar.zst").upload,
			"the Windows .tar.zst is being attached. Windows tar.exe cannot read zstd, so it is the updater's file and a human who downloads it is simply stuck. Fix: keep the rejection; the zip is the file for people.",
		).toBe(false);
		expect(
			classifyCanaryArtifact("canary-linux-x64-dev-3.0.tar.zst").upload,
			"the LINUX .tar.zst is now rejected too, and on Linux that IS the human's download. Fix: scope the rejection to win-*.",
		).toBe(true);
	});

	it("explains every rejection instead of dropping the file silently", () => {
		for (const name of ["canary-win-x64-update.json", "x-Setup-canary.zip", "canary-win-x64-app.tar.zst"]) {
			const verdict = classifyCanaryArtifact(name);
			expect(verdict.upload).toBe(false);
			expect(
				"reason" in verdict && verdict.reason.length,
				`${name} is rejected with no reason. The run log is the only place anyone sees why a file is missing from the release. Fix: give the branch a sentence.`,
			).toBeGreaterThan(20);
		}
	});

	it("labels each file with a platform the publisher actually builds", () => {
		expect(platformOfArtifact("canary-win-x64-dev-3.0-canary.zip")).toBe("win-x64");
		expect(platformOfArtifact("canary-macos-arm64-dev-3.0.dmg")).toBe("macos-arm64");
		expect(platformOfArtifact("dev3-cli-something.tar.gz")).toBe("cli");
	});

	// Observed by running the publisher rather than by reading it: the CLI tarball carries the
	// same os-arch token as the app build, so the table printed two rows labelled `macos-arm64`
	// and nothing said which one was the app.
	it("keeps the CLI tarball distinguishable from the app build for the same platform", () => {
		expect(
			platformOfArtifact("dev3-cli-macos-arm64.tar.gz"),
			"the CLI tarball is labelled with a bare platform, identical to the DMG's label. A reader on the release page then sees two `macos-arm64` rows and cannot tell which file is the app. Fix: keep the cli- prefix.",
		).toBe("cli-macos-arm64");
		expect(platformOfArtifact("canary-macos-arm64-dev-3.0.dmg")).toBe("macos-arm64");
	});
});

/**
 * THE MERGE IS WHY THE LEDGER EXISTS. A canary run rebuilds only the platforms whose own feed
 * is behind, so the release legitimately holds a Windows zip from one commit next to a DMG
 * from an older one. Windows trees are not byte-reproducible either — one sha built three
 * times gave three different zips — so a row must name the RUN, not just the commit.
 */
describe("the ledger of which run produced which file", () => {
	it("replaces the row for a file this run rebuilt", () => {
		const merged = mergeCanaryLedger(
			{ assets: [entry({ runId: "1", sha: "aaaaaaaaa1", builtAt: "2026-08-13T00:00:00.000Z" })] },
			[entry({ runId: "2", sha: "bbbbbbbbb2" })],
		);
		expect(merged.assets).toHaveLength(1);
		expect(merged.assets[0]).toMatchObject({ runId: "2", sha: "bbbbbbbbb2" });
	});

	it("keeps the rows for platforms this run did NOT build", () => {
		const merged = mergeCanaryLedger(
			{ assets: [entry({ asset: "canary-macos-arm64-dev-3.0.dmg", platform: "macos-arm64", runId: "1" })] },
			[entry({ runId: "2" })],
		);
		expect(
			merged.assets.map((a) => `${a.asset}@${a.runId}`),
			"a platform absent from this run lost its row, so the release body would claim every attached file came from this run while the older assets are still attached and downloadable. Fix: merge by asset name instead of replacing the ledger.",
		).toEqual(["canary-macos-arm64-dev-3.0.dmg@1", "canary-win-x64-dev-3.0-canary.zip@2"]);
	});

	it("survives a first run with no ledger at all", () => {
		expect(mergeCanaryLedger(null, [entry()]).assets).toHaveLength(1);
	});

	it("treats an unreadable ledger as absent rather than throwing mid-publish", () => {
		expect(parseCanaryLedger("<!doctype html>")).toBeNull();
		expect(parseCanaryLedger("{}"), "a ledger with no assets array must not be trusted").toBeNull();
		expect(parseCanaryLedger(JSON.stringify({ assets: [entry()] }))?.assets).toHaveLength(1);
	});
});

describe("the release body", () => {
	const body = renderCanaryReleaseBody({
		ledger: mergeCanaryLedger(null, [entry(), entry({ asset: "canary-macos-arm64-dev-3.0.dmg", platform: "macos-arm64" })]),
		version: "1.44.0+canary.42ee05e8",
		repoUrl: "https://github.com/h0x91b/dev-3.0",
		generatedAt: "2026-08-14T12:00:00.000Z",
	});

	it("says in its first lines that this is not the stable download", () => {
		const preview = body.split("\n").slice(0, 6).join("\n");
		expect(
			preview,
			"the warning left the opening lines. The releases page shows only the beginning of the body under the title, and that preview is all most people read before clicking a download. Fix: keep the warning first.",
		).toMatch(/not the release you want/i);
		expect(preview).toMatch(/unsigned/i);
	});

	it("points at the stable release for anyone who landed here by mistake", () => {
		expect(body).toContain("/releases/latest");
	});

	it("names the run behind every file, not just the commit", () => {
		expect(
			body,
			"a row no longer links its run. Windows trees are not byte-reproducible (one sha, three runs, three different zips), so the commit alone does not identify the bytes anybody downloaded. Fix: keep the run column.",
		).toContain("/actions/runs/31300000001");
		expect(body).toContain("canary-win-x64-dev-3.0-canary.zip");
		expect(body).toContain("canary-macos-arm64-dev-3.0.dmg");
	});

	// The in-app channel switch REFUSES on every non-macOS platform (src/bun/updater.ts: the
	// running app IS the channel folder there, so an in-place switch would install where the
	// launcher never starts) and its error text sends the user to "the releases page". This is
	// that page, and it is the only Windows bootstrap there is.
	it("tells a Windows user sent here by the app's refusal which file is theirs", () => {
		expect(
			body,
			"the body no longer explains the arrival from the updater's cross-channel refusal. On Windows that refusal is the ONLY route to canary, and its message says to install the build from the releases page — landing on a page that does not mention it is a dead end. Fix: keep the section, and keep the win-x64 row it points at.",
		).toMatch(/refusal/i);
		expect(body).toContain("win-x64");
	});

	it("says updates do not come from this page", () => {
		expect(
			body,
			"the body no longer states that the updater reads the S3 feed. Without it the next reader assumes the release page is a feed and 'fixes' ordering by editing releases. Fix: keep the section.",
		).toMatch(/buildOrder/);
	});

	it("does not advertise its own bookkeeping file as a download", () => {
		expect(
			body.includes(`| ${CANARY_LEDGER_ASSET} |`) || body.includes(`[\`${CANARY_LEDGER_ASSET}\`]`),
			`${CANARY_LEDGER_ASSET} is listed as a download. It is the provenance record, not a build. Fix: filter it out of the table.`,
		).toBe(false);
	});
});

/**
 * THE ONE THAT WOULD SHIP A RELEASE NOBODY ASKED FOR. release.yml fires on tag pushes, and
 * this publisher moves its tag on every canary publish. If the two ever overlap, each canary
 * build starts a full stable release: signed DMGs to the stable feed, GitHub release notes for
 * a version that was never cut, and a Homebrew cask pointing at a canary build.
 */
describe("the canary tag cannot start a stable release", () => {
	/** The `tags:` list read out of release.yml itself, so a change there is caught here. */
	const filters = (/^ {2}push:\n {4}tags:\s*\[([^\]]+)\]/m.exec(RELEASE_WORKFLOW)?.[1] ?? "")
		.split(",")
		.map((raw) => raw.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);

	it("finds release.yml's tag filters to check against", () => {
		expect(
			filters,
			"release.yml's `push: tags: [...]` list could not be read, so this test would pass by checking nothing. Fix: update the pattern above to match how the trigger is now written.",
		).not.toEqual([]);
	});

	it("matches none of them", () => {
		const hits = filters.filter((glob) =>
			new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(CANARY_RELEASE_TAG),
		);
		expect(
			hits,
			`the canary tag "${CANARY_RELEASE_TAG}" matches release.yml's filter(s) ${hits.join(", ")}. Every canary publish moves that tag, so each one would start a full stable release — signed DMGs on the stable feed and a Homebrew cask edit pointing at a canary build. Fix: rename the canary tag, never widen the filter.`,
		).toEqual([]);
	});
});

/**
 * `/releases/latest` skips prereleases, and that is the entire guard. Two callers outside CI
 * depend on it: src/bun/rosetta.ts hands the URL to a user running the wrong architecture, and
 * docs/index.html's download buttons point at it.
 */
describe("the canary release is never the default download", () => {
	it("is created as a pre-release that is not Latest", () => {
		const create = /release", "create"[\s\S]*?\);/.exec(SCRIPT)?.[0] ?? "";
		expect(create, "the create call could not be found in the publisher").not.toBe("");
		expect(
			create,
			"the canary release is created without --prerelease, so GitHub marks it Latest. src/bun/rosetta.ts and every download button on docs/index.html resolve /releases/latest, so casual visitors would be handed an unsigned build of whatever main was at. Fix: pass --prerelease.",
		).toContain("--prerelease");
		expect(
			create,
			"the canary release is created without --latest=false. --prerelease alone keeps it off /releases/latest today, but the explicit flag is what survives someone flipping the prerelease bit by hand. Fix: pass --latest=false.",
		).toContain("--latest=false");
	});

	it("re-asserts both on every refresh, not only at creation", () => {
		const edit = /release", "edit"[\s\S]*?\);/.exec(SCRIPT)?.[0] ?? "";
		expect(edit, "the edit call could not be found in the publisher").not.toBe("");
		expect(
			edit,
			"the refresh path does not re-assert --prerelease, so a release flipped to a full one by hand — or by a future gh default — stays that way and quietly becomes the default download. Fix: pass --prerelease on edit too.",
		).toContain("--prerelease");
		expect(edit, "the refresh path does not re-assert --latest=false. Same failure, same fix.").toContain("--latest=false");
	});

	// Not a style rule: the app must never learn to read releases. Ordering lives in
	// `buildOrder` in the manifest, and a second source of truth would order builds by a
	// version string or by publish date, which is exactly what the two channels cannot do.
	it("leaves the updater reading the bucket and nothing else", () => {
		const updater = read("../updater.ts");
		expect(
			/github\.com|api\.github/.test(updater),
			"src/bun/updater.ts now references GitHub. The canary release page is a download surface for humans; making the app read it turns release publish dates into update ordering and breaks the channel rules. Fix: the feed is BASE_URL in the bucket.",
		).toBe(false);
	});
});

describe("the job that refreshes the release", () => {
	const job = /^ {2}release-page:$[\s\S]*$/m.exec(CANARY_WORKFLOW)?.[0] ?? "";

	it("exists at all", () => {
		expect(job, "canary-publish.yml has no `release-page` job, so canary builds reach the bucket and no page. Fix: restore the job.").not.toBe("");
	});

	it("runs when ANY platform built, naming every platform the publisher has", () => {
		const missing = CANARY_PLATFORMS.map((p) => `${p.os}-${p.arch}`).filter(
			(key) => !job.includes(`needs.build-${key}.result == 'success'`),
		);
		expect(
			missing,
			`the release-page condition does not mention ${missing.join(", ")}. A run where only that platform built would leave the page untouched — the bucket would move and the download page would not, silently, forever. Fix: add the missing term.`,
		).toEqual([]);
	});

	it("does not run on a quiet hour", () => {
		expect(
			job,
			"the release-page job lost its `if:`, so every quiet hour rewrites the release body with no new build behind it. Fix: keep the any-platform-succeeded condition.",
		).toMatch(/^ {4}if:/m);
		expect(
			job,
			"the condition no longer requires a SUCCESSFUL build. With `always()` and nothing else, a run whose builds all failed would still refresh the page. Fix: compare each build's `result` to 'success'.",
		).toContain("== 'success'");
	});

	// The proof gates the builds, and the builds gate this. Depending on `decide` alone would
	// let the page refresh from artifacts of a run whose Windows packaging never passed.
	it("hangs off the build jobs rather than off decide", () => {
		expect(
			job,
			"the release-page job no longer needs the build jobs, so it can run before or without them and publish whatever happens to be in the artifact store. Fix: keep every build job in `needs`.",
		).toMatch(/needs:.*build-win-x64/);
	});

	// The run also carries the Windows proof's artifacts, including the ~400 MB unpacked launch
	// tree. Unfiltered, `merge-multiple: true` flattens every loose .exe and .dll of it into the
	// directory the publisher uploads from — and each one gets attached to the release.
	it("downloads only the release build artifacts", () => {
		expect(
			job,
			"the artifact download is no longer scoped by `pattern: artifacts-*`. This run also holds the Windows proof's unpacked launch tree, so an unfiltered merge attaches hundreds of loose .exe and .dll files to the public release page. Fix: restore the pattern.",
		).toMatch(/pattern:\s*artifacts-\*/);
	});

	it("is the only job allowed to write to the repository", () => {
		expect(
			job,
			"the release-page job has no `permissions: contents: write`, and the workflow default is read — every publish would fail on the tag move. Fix: grant it at job level.",
		).toMatch(/permissions:\s*\n\s+contents:\s*write/);
		expect(
			/^permissions:\n {2}contents:\s*read/m.test(CANARY_WORKFLOW),
			"the workflow-level permission is no longer `contents: read`, so every build job can edit releases and refs too. Fix: keep the default read and grant write on the one job that needs it.",
		).toBe(true);
	});
});
