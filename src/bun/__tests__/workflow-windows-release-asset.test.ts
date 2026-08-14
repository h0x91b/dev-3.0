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
 * A Windows failure SINKS THE RELEASE, macOS disk images included. Windows was best-effort until
 * Arseny made it first-class ("теперь надо фейлить всё"), and the tolerance is gone at the root:
 * release-build-windows.yml has no `bestEffort` input and no `continue-on-error` at all, so
 * neither caller can choose to survive a broken Windows build. What these assertions pin is the
 * absence — a re-added input, or a `continue-on-error` on the build job, restores the old
 * behaviour with every test that only reads release.yml still green.
 *
 * The Linux legs keep their own `bestEffort` (linux-arm64's GUI bundle is genuinely unproven) and
 * are asserted here so a sweep over this file's diff cannot quietly take them along.
 * See decisions/2026/08/14/windows-failure-fails-the-release.md.
 */
describe("a Windows failure sinks the release", () => {
	it("gives the Windows leg no tolerance switch at all", () => {
		expect(
			WINDOWS_BUILD,
			"release-build-windows.yml took back a `bestEffort` input. Windows is fail-closed on both channels now, and an input every caller pins to `false` is an escape hatch waiting to be flipped to `true` — which is exactly how a stable release shipped Windows-less while every job stayed green. Fix: delete the input.",
		).not.toMatch(/^ {6}bestEffort:$/m);
		expect(
			WINDOWS_BUILD,
			"release-build-windows.yml grew a `continue-on-error`, so a Windows failure can be swallowed before the caller ever reads the job's result. Fix: remove it — the job must fail its caller.",
		).not.toMatch(/^\s*continue-on-error:/m);
	});

	it("refuses the failure in a tagged release and in canary alike", () => {
		expect(
			RELEASE_JOBS.get("build-win-x64") ?? "",
			"release.yml passes `bestEffort` to the Windows leg again. That input no longer exists, so the workflow dies at dispatch time — and if it were restored, a broken Windows build would stop failing the release, which is the behaviour Arseny asked to end.",
		).not.toMatch(/^ {6}bestEffort:/m);
		expect(
			jobs(CANARY).get("build-win-x64") ?? "",
			"canary-publish.yml passes `bestEffort` to the Windows leg again; the input is gone, so GitHub fails the hourly canary at dispatch time with no build at all.",
		).not.toMatch(/^ {6}bestEffort:/m);
	});

	it("leaves the Linux legs' best-effort semantics alone", () => {
		expect(
			RELEASE_JOBS.get("build-linux-arm64") ?? "",
			"linux-arm64 stopped passing `bestEffort: true`. Its Electrobun GUI bundle is not proven yet, and making Windows fail-closed was never a reason to let that platform block a release. Fix: restore it.",
		).toMatch(/^ {6}bestEffort: true$/m);
		expect(
			RELEASE_JOBS.get("build-linux-x64") ?? "",
			"linux-x64 stopped passing `bestEffort: false`; it is a first-class platform and its failure must fail the release.",
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

	it("keeps no step that reports a Windows-less release", () => {
		// The `release` job cannot start unless build-win-x64 succeeded (asserted above), so a
		// missing Windows zip is impossible by construction and a step warning about one is a
		// branch that can never run — the kind this repo deletes rather than deprecates.
		expect(
			RELEASE_JOBS.get("release") ?? "",
			"the `Warn when the Windows build is missing` step is back. It was the other half of `bestEffort: true`; with Windows fail-closed it can never fire, and a step whose message says the release ships without Windows now describes a state that cannot exist. Fix: delete it.",
		).not.toMatch(/Release has NO Windows build/);
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
