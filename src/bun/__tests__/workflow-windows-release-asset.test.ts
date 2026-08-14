/**
 * A tagged release must carry a Windows file a human can click, and it must say the build is
 * unsigned.
 *
 * v1.43.0 and v1.44.0 shipped exactly two macOS disk images and four CLI tarballs; Windows was
 * packaged and launch-proved on every in-scope merge and appeared nowhere a person could reach.
 * The gap was never packaging, it was DISTRIBUTION — so what these assertions pin is the
 * distribution wiring, and each one is a way for the asset to quietly stop existing while every
 * job stays green:
 *
 *   - the release stops calling the Windows build at all;
 *   - it calls it for the wrong channel, publishing canary-named files into a stable release;
 *   - the release body is cut before the Windows build finishes, so the artifact is not there yet;
 *   - the zip is downloaded into the release job and never attached;
 *   - the unproven self-extracting installer is attached instead of the launched tree;
 *   - the Windows section grows a hand-written entry point, which can name an executable no proof
 *     started — the one class of mistake nobody publishing a release from macOS can catch.
 *
 * Read as raw text like every sibling workflow test (`yaml` is not a declared dependency), and
 * every message names the CAUSE and the FIX, because a text pin trips on harmless reshaping too.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RELEASE = readFileSync(fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url)), "utf8");
const WINDOWS_BUILD = readFileSync(
	fileURLToPath(new URL("../../../.github/workflows/release-build-windows.yml", import.meta.url)),
	"utf8",
);
const CANARY = readFileSync(
	fileURLToPath(new URL("../../../.github/workflows/canary-publish.yml", import.meta.url)),
	"utf8",
);

/** Job blocks under `jobs:`, comments dropped so a quoted command cannot be read as code. */
function jobs(yaml: string): Map<string, string> {
	const start = yaml.search(/^jobs:$/m);
	expect(start, "release.yml has no top-level `jobs:` key; this test cannot read it").toBeGreaterThanOrEqual(0);
	const found = new Map<string, string>();
	let name = "";
	let body: string[] = [];
	for (const line of yaml.slice(start).split(/\r?\n/)) {
		const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (header) {
			if (name) found.set(name, body.join("\n"));
			name = header[1];
			body = [];
			continue;
		}
		if (name && !line.trim().startsWith("#")) body.push(line);
	}
	if (name) found.set(name, body.join("\n"));
	return found;
}

const RELEASE_JOBS = jobs(RELEASE);

describe("a tagged release builds Windows", () => {
	const win = RELEASE_JOBS.get("build-win-x64") ?? "";

	it("calls the Windows publishing leg", () => {
		expect(
			win,
			"release.yml has no `build-win-x64` job, so a tagged release produces no Windows file at all — the exact state v1.44.0 shipped in (two macOS DMGs, four CLI tarballs, nothing for Windows). Fix: call ./.github/workflows/release-build-windows.yml, shaped like the macOS and Linux callers. See decisions/2026/08/14/windows-zip-on-the-release-page.md.",
		).not.toBe("");
		expect(win, "the Windows leg must be the shared reusable workflow, not a second copy of the build steps in this file.").toMatch(
			/uses:\s*\.\/\.github\/workflows\/release-build-windows\.yml/,
		);
	});

	it("builds it for the stable channel, not canary", () => {
		expect(
			win,
			"a tagged release that passes `channel: canary` publishes `canary-win-x64-…` files, named for the channel canary clients poll, into a stable release — and the app bundle records the wrong channel with the run entirely green. Fix: `channel: stable`.",
		).toMatch(/^ {6}channel: stable$/m);
	});

	it("waits for it before cutting the release", () => {
		const release = RELEASE_JOBS.get("release") ?? "";
		expect(release, "the `release` job vanished from release.yml; this test needs it").not.toBe("");
		expect(
			release,
			"the `release` job does not list `build-win-x64` in its `needs:`, so the release body and its assets are produced BEFORE the Windows build finishes: the download step finds no zip, and the release publishes without Windows while every job goes green. Fix: add build-win-x64 to `needs:`.",
		).toMatch(/^ {4}needs:.*\bbuild-win-x64\b/m);
	});
});

/**
 * A Windows failure must not hold a proven macOS/Linux release hostage — by the time the Windows
 * leg could fail, both have already run their own `aws s3 sync`, including the sync to the bucket
 * root the updater polls. The mechanism is the same `bestEffort` input `linux-arm64` uses, and it
 * comes as a PAIR: tolerate the failure, then say out loud that Windows is missing. Either half
 * alone is a defect — tolerance without the warning ships a silently Windows-less release, and
 * the warning without tolerance is decoration on a failed run.
 */
describe("a Windows failure does not sink the release", () => {
	it("gives the Windows leg the same bestEffort switch as the Linux leg", () => {
		expect(
			WINDOWS_BUILD,
			"release-build-windows.yml no longer takes a `bestEffort` input, so its callers cannot choose whether a Windows failure is fatal — and release.yml's choice (it must not be) is the only reason a tolerated failure is survivable there. Fix: restore the required boolean input.",
		).toMatch(/^ {6}bestEffort:$/m);
		expect(
			WINDOWS_BUILD,
			"the tolerance is not applied at job level, so the called workflow still fails and takes its caller with it — a step-level `continue-on-error` cannot help, because the caller reads the JOB's result. Fix: `continue-on-error: ${{ inputs.bestEffort }}` on the build job, like release-build-linux.yml.",
		).toMatch(/^ {4}continue-on-error: \$\{\{ inputs\.bestEffort \}\}$/m);
	});

	it("tolerates it in a tagged release and refuses to in canary", () => {
		expect(
			RELEASE_JOBS.get("build-win-x64") ?? "",
			"release.yml does not pass `bestEffort: true`, so a Windows packaging failure fails the whole release — after macOS and Linux already published to the bucket, which abandons a shipped update halfway and produces no GitHub Release at all.",
		).toMatch(/^ {6}bestEffort: true$/m);
		// The canary run publishes NOTHING BUT Windows, so a failure there is the run. `false` is
		// also GitHub's default for continue-on-error, which is what makes passing it explicitly a
		// no-op on canary's behaviour rather than a change to it.
		//
		// SCOPED TO THE WINDOWS JOB, not the file: canary-publish.yml also passes
		// `bestEffort: false` for linux-x64, so a file-wide match stays green while the Windows
		// call site loses the input entirely. Verified by deleting that one line.
		expect(
			jobs(CANARY).get("build-win-x64") ?? "",
			"canary-publish.yml stopped passing `bestEffort: false`. Windows is the only thing that run publishes, so tolerating a failure there hides the entire point of the run — and adding a required input without updating this call site fails the workflow at dispatch time, which no test here would otherwise catch.",
		).toMatch(/^ {6}bestEffort: false$/m);
	});

	it("passes every input the Windows leg requires, from every caller", () => {
		const inputsBlock = WINDOWS_BUILD.slice(WINDOWS_BUILD.search(/^ {4}inputs:$/m), WINDOWS_BUILD.search(/^jobs:$/m));
		// One entry per input: its name, then everything up to the NEXT six-space key.
		// TWO TRAPS, BOTH SPRUNG WHILE WRITING THIS, both silent:
		//   - splitting on a literal "\n      " cuts at the eight-space `description:` lines too,
		//     because six spaces are a prefix of eight, and every input then looks optional;
		//   - `\Z` is not a JS anchor — it matches a literal "Z" — so a lookahead ending
		//     `(?=^ {6}\S|\Z)` drops the LAST input, which is always the newest one. That is the
		//     input a call site is most likely to be missing, and the detector went blind on
		//     exactly it while reporting five happily-parsed siblings.
		const names = [...inputsBlock.matchAll(/^ {6}([A-Za-z0-9_-]+):$/gm)];
		const required = names
			.filter((m, i) => {
				const end = i + 1 < names.length ? names[i + 1].index : inputsBlock.length;
				return /^ {8}required: true$/m.test(inputsBlock.slice(m.index, end));
			})
			.map((m) => m[1]);
		expect(required.length, "no required inputs were parsed out of release-build-windows.yml, so this assertion is vacuous. Fix the parser, do not delete the test.").toBeGreaterThan(3);

		const missing: string[] = [];
		for (const [file, yaml] of [
			["release.yml", RELEASE],
			["canary-publish.yml", CANARY],
		] as const) {
			for (const [job, body] of jobs(yaml)) {
				if (!body.includes("uses: ./.github/workflows/release-build-windows.yml")) continue;
				for (const input of required) {
					if (!new RegExp(`^ {6}${input}:`, "m").test(body)) missing.push(`${file} job ${job} omits ${input}`);
				}
			}
		}
		expect(
			missing,
			`A caller of release-build-windows.yml omits a required input:\n${missing.join("\n")}\nGitHub fails the workflow at dispatch time for this, so the release or the hourly canary dies with a red X and no build — visible only once someone tags. Fix: pass the input at that call site.`,
		).toEqual([]);
	});

	it("says out loud when the release ships without Windows", () => {
		const release = RELEASE_JOBS.get("release") ?? "";
		expect(
			release,
			"nothing warns when the Windows zip is absent. With `bestEffort: true` that is the failure mode: release created, macOS and Linux attached, every job green, and the only trace is a missing section in the notes that nobody diffs. Fix: keep the `Warn when the Windows build is missing` step.",
		).toMatch(/::warning title=Release has NO Windows build::/);
		expect(
			release,
			"the warning does not name the run, so the next reader cannot tell a Windows failure from a Windows build that never started. Fix: include the run URL.",
		).toMatch(/github\.run_id/);
	});
});

describe("the Windows zip reaches the release page", () => {
	const upload = RELEASE_JOBS.get("release") ?? "";

	it("attaches the zip as a release asset", () => {
		expect(
			upload,
			"nothing in the `release` job runs `gh release upload` on a Windows zip, so the build is downloaded into the job and thrown away — a release page with no Windows file, which is the whole defect this leg exists to fix. Fix: keep the step that uploads all-artifacts/*win-x64*.zip.",
		).toMatch(/win-x64\*\.zip/);
	});

	it("never attaches the self-extracting installer", () => {
		expect(
			upload,
			"the upload step no longer skips `*Setup*`. That file is built by every Windows build and has never been launched by any job, test or proof; attaching it hands a human the unvetted binary while the proven one stays decoration. Fix: restore the case-skip. See decisions/2026/08/06/downloadable-windows-build-is-the-launched-tree.md.",
		).toMatch(/\*Setup\*/);
	});

	it("does not link the notes fragment as if it were a published file", () => {
		expect(
			upload,
			"the `All artifacts` list links every file to the S3 bucket, and windows-release-notes.md is prose handed between jobs — it never reaches the bucket, so listing it ships a dead download link. Fix: keep skipping it in that loop.",
		).toMatch(/windows-release-notes\.md.*continue|continue.*windows-release-notes\.md/s);
	});
});

describe("the unsigned warning travels with the download", () => {
	it("takes the Windows section from the build job instead of writing it here", () => {
		const release = RELEASE_JOBS.get("release") ?? "";
		expect(
			release,
			"release.yml stopped appending all-artifacts/windows-release-notes.md, which means the Windows section is either gone or hand-written in this file. Hand-written is the dangerous one: this workflow runs on ubuntu and cannot know which executable the Windows launch proof spawned, so it can advertise an entry point nothing started. Fix: keep appending the fragment the Windows job renders from its own proof.",
		).toMatch(/windows-release-notes\.md/);
		expect(
			release,
			"the Windows download section must not be spelled out in this file — an entry point written here is a guess. Fix: let scripts/package-windows-launched-tree.ts render it from windows-app-launch-proof.json.",
		).not.toMatch(/launcher\.exe/);
	});

	it("has the build job publish that fragment", () => {
		expect(
			WINDOWS_BUILD,
			"release-build-windows.yml no longer uploads the release-notes fragment, so release.yml finds nothing to append and a tagged release ships a Windows zip with no instructions and no unsigned-launch warning — a user meeting an unexplained full-screen SmartScreen dialog reads it as a malware verdict. Fix: keep the `windows-release-notes-<channel>-<arch>` upload.",
		).toMatch(/name: windows-release-notes-/);
		expect(
			WINDOWS_BUILD,
			"the fragment upload lost `if-no-files-found: error`, so a run that rendered nothing uploads an empty artifact and the release silently omits Windows. Fix: restore it.",
		).toMatch(/windows-release-notes\.md\n\s+if-no-files-found: error/);
	});
});
