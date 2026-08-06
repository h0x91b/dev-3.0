/**
 * Tripwires for the packaged Windows proof: where it runs, where it must NOT run, and
 * what it has to gate before anything publishes.
 *
 * The proof briefly gated pull requests
 * (decisions/2026/08/06/required-checks-wait-for-windows-packaging.md — full slugs on purpose,
 * bare record numbers collided four times in one day). That cost +4m47 on every
 * in-scope PR and was reversed: it now runs post-merge on `main` and in front of the
 * release's publishing jobs. See
 * decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md.
 *
 * These read workflow YAML as raw text, like their siblings — `yaml` is not a declared
 * dependency. Every assertion here must fail naming the CAUSE and the FIX, because a
 * text pin trips on any reshaping and a message that merely restates the invariant
 * sends the next reader after a phantom regression.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflow = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)), "utf8");

const PACKAGE_WORKFLOW = workflow("windows-conpty-package.yml");
const MAIN_WORKFLOW = workflow("windows-proof-main.yml");
const BUILD_WORKFLOW = workflow("build.yml");
const RELEASE_WORKFLOW = workflow("release.yml");

/**
 * Job blocks under `jobs:`, keyed by job name: two spaces, a name, a colon, end of line.
 * Comment lines are dropped — a comment quoting a `run:` command would otherwise make
 * the neighbouring job look like it contained one.
 */
function jobs(yaml: string): Map<string, string> {
	const start = yaml.search(/^jobs:$/m);
	expect(start, "the workflow has no top-level `jobs:` key; this test cannot read it").toBeGreaterThanOrEqual(0);
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

/** The `run:` body of one named step, comments stripped — same shape as the sibling gate tests. */
function stepBlock(yaml: string, name: string, file: string): string {
	const lines = yaml.split("\n");
	const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+name:\\s*${name}\\s*$`).test(line));
	expect(start, `step "${name}" is missing from ${file}`).toBeGreaterThanOrEqual(0);
	const block: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*-\s+(name|uses):/.test(line)) break;
		if (!line.trim().startsWith("#")) block.push(line);
	}
	return block.join("\n");
}

function jobLevelKeys(yaml: string, key: string): string[] {
	return [...jobs(yaml)]
		.filter(([, body]) => new RegExp(`^ {4}${key}:`, "m").test(body))
		.map(([name]) => name);
}

describe("the reusable packaged Windows proof", () => {
	// Its callers read the CALLER job's result. A called workflow whose internal job
	// skips still reports success upward, so a job-level `if:` in here would let a
	// caller pass on a package that never packaged — absence looking like success one
	// level deeper than any caller can see.
	it("has no job-level if:, which no caller could see through", () => {
		expect(
			jobLevelKeys(PACKAGE_WORKFLOW, "if"),
			"A job-level `if:` here skips silently while the workflow still reports success to its caller, so a release could publish on a package that never packaged. Fix: express scope in WINDOWS_SCOPE_PATHS, which the caller evaluates — see decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md.",
		).toEqual([]);
	});

	it("has no job-level continue-on-error, which would hide a failed package", () => {
		expect(
			jobLevelKeys(PACKAGE_WORKFLOW, "continue-on-error"),
			"A job-level `continue-on-error:` here turns a broken Windows package into a green proof, and the release gate reads that green. Fix: delete it and let the job fail.",
		).toEqual([]);
	});

	it("is reusable and owns no trigger of its own", () => {
		expect(
			PACKAGE_WORKFLOW,
			"the proof must stay callable, or both its callers (windows-proof-main.yml and release.yml) break. Fix: keep `workflow_call:` under `on:`.",
		).toMatch(/^\s{2}workflow_call:/m);
		expect(
			/^\s{2}pull_request:/m.test(PACKAGE_WORKFLOW),
			"a pull_request trigger here puts the ~5-minute packaging cost back on every PR, which is exactly what decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md removed. Fix: leave the trigger to the callers.",
		).toBe(false);
	});
});

/**
 * The packaged Windows app was built, proved launchable and then discarded, so the one
 * platform with no local machine in the loop had nothing anybody could obtain. These pin
 * the shape of the fix, and the load-bearing one is the LAUNCHED-BYTES tripwire: the
 * directory published for download has to be the directory the launch proof spawned
 * from, or the download is a look-alike wearing a proof's green tick.
 */
describe("the packaged Windows app is downloadable", () => {
	const UPLOAD_STEP = "Upload the launched Windows app for download";
	const LAUNCH_STEP = "Launch the packaged Windows app and prove clean shutdown";
	const upload = stepBlock(PACKAGE_WORKFLOW, UPLOAD_STEP, "windows-conpty-package.yml");
	const launch = stepBlock(PACKAGE_WORKFLOW, LAUNCH_STEP, "windows-conpty-package.yml");
	const proofUpload = stepBlock(PACKAGE_WORKFLOW, "Upload real Windows archive proof", "windows-conpty-package.yml");

	/** The single directory name both steps must agree on, read off the upload step. */
	const publishedDir = /path:\s*([^\s]+?)\/?\s*$/m.exec(upload)?.[1] ?? "";

	it("publishes exactly the tree the launch proof spawned from", () => {
		expect(
			publishedDir,
			`the "${UPLOAD_STEP}" step no longer declares a single \`path:\` directory, so there is nothing to check the launch proof against. Fix: keep it publishing one directory.`,
		).not.toBe("");
		expect(
			launch,
			`the "${LAUNCH_STEP}" step does not point DEV3_WINDOWS_APP_UNPACK_DIR at ${publishedDir}, so the proof extracts into a temp workspace it deletes and the upload publishes a look-alike nobody ever launched. Fix: set DEV3_WINDOWS_APP_UNPACK_DIR to the same directory the upload step publishes.`,
		).toMatch(new RegExp(`DEV3_WINDOWS_APP_UNPACK_DIR:.*${publishedDir}`));
	});

	it("publishes nothing when the launch proof failed", () => {
		expect(
			/^\s*if:/m.test(upload),
			`the "${UPLOAD_STEP}" step grew an \`if:\`. Its absence is what stops a failed launch from publishing a build that never reached a window — \`if: always()\` looks like debugging convenience and is exactly wrong here. Fix: delete the condition and let step order gate it.`,
		).toBe(false);
	});

	it("refuses to advertise an empty download", () => {
		expect(
			upload,
			`the "${UPLOAD_STEP}" step no longer sets \`if-no-files-found: error\`, so a build that produced nothing publishes a green "download it here" summary pointing at an empty artifact. Fix: restore it.`,
		).toMatch(/if-no-files-found:\s*error/);
	});

	it("keeps the download off the default 90-day retention", () => {
		expect(
			upload,
			`the "${UPLOAD_STEP}" step no longer pins \`retention-days\`, so it falls back to 90 days. The risk is not storage — it is a months-old build still listed and downloaded as if it were current. Fix: set retention-days explicitly, and say so in the run summary.`,
		).toMatch(/retention-days:\s*\d+/);
	});

	it("keeps the JSON proof and the payload in separate artifacts", () => {
		expect(
			/\.tar\.zst|\.zip|unpacked/.test(proofUpload),
			"the proof artifact picked up a packaged payload. It is JSON downloaded constantly by CI; folding a ~400 MB build into it makes every proof download drag the payload behind it. Fix: leave the build in its own artifact.",
		).toBe(false);
	});

	it("tells a human how to run it, from the proof rather than from prose", () => {
		const explain = stepBlock(
			PACKAGE_WORKFLOW,
			"Explain how to run the downloadable Windows build",
			"windows-conpty-package.yml",
		);
		expect(
			explain,
			"the run summary is no longer generated from the launch proof, so nothing stops it naming an executable the proof never started — the failure this path exists to prevent. Fix: keep `bun scripts/windows-download-summary.ts`, which reads windows-app-launch-proof.json.",
		).toMatch(/bun scripts\/windows-download-summary\.ts/);
	});
});

describe("pull requests do not pay for the Windows proof", () => {
	// The whole point of the reversal. A `needs:` edge back onto the packaging workflow
	// re-adds +4m47 to the required `test` context on every in-scope PR.
	it("never calls the packaging workflow from build.yml", () => {
		expect(
			BUILD_WORKFLOW.includes("windows-conpty-package.yml"),
			"build.yml runs on pull_request, so calling the packaging workflow from here charges every in-scope PR ~+4m47 on the required `test` context (measured on run 31083965892) — the cost that decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md reversed. Fix: leave the proof to windows-proof-main.yml and release.yml.",
		).toBe(false);
	});

	it("leaves no Windows gate behind in the required test context", () => {
		const test = jobs(BUILD_WORKFLOW).get("test") ?? "";
		expect(test, "the `test` job vanished from build.yml; this test needs it").not.toBe("");
		expect(
			/windows/i.test(test),
			"the required `test` context references Windows again. Either the proof is gating PRs once more, or a dead reference to the deleted gate survived. Fix: PR-side Windows gating was removed on purpose — see decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md.",
		).toBe(false);
	});
});

describe("the post-merge Windows proof on main", () => {
	it("triggers on pushes to main and on nothing else", () => {
		expect(
			MAIN_WORKFLOW,
			"the post-merge proof must fire on merges to main, which is what makes a break attributable to one commit. Fix: restore the `push: branches: [main]` trigger.",
		).toMatch(/^on:\n\s{2}push:\n\s{4}branches:\s*\[main\]/m);
		expect(
			/^\s{2}pull_request:/m.test(MAIN_WORKFLOW),
			"a pull_request trigger here re-charges PRs for the proof, undoing decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md. Fix: keep this workflow post-merge only.",
		).toBe(false);
	});

	// The DEFAULT IS DELIBERATELY THE OPPOSITE of the PR gate this replaced: there an
	// undecidable scope failed, because a required context claiming "Windows was
	// checked" on a guess is a lie. Here nobody is waiting, so it proves.
	it("proves Windows when the pushed range does not resolve, instead of skipping", () => {
		const scope = stepBlock(
			MAIN_WORKFLOW,
			"Decide whether the packaged Windows proof is in scope",
			"windows-proof-main.yml",
		);
		expect(
			scope,
			"the pushed range is what scope is computed from. Fix: read github.event.before and github.sha into the step.",
		).toMatch(/PUSHED_BEFORE/);
		const fallback = scope.slice(0, scope.indexOf("git diff"));
		expect(
			fallback,
			"an unresolvable push range (force push, branch creation, all-zero `before`) must fall back to PROVING Windows. Fix: set `in-scope=true` in that branch — post-merge the cost of a needless proof is minutes nobody waits on, and skipping loses the only detector the platform has.",
		).toMatch(/in-scope=true/);
		expect(
			fallback,
			"the unresolvable-range branch must not fail the run — that is the PR-side default and aligning the two was explicitly rejected. Fix: exit 0 after proving.",
		).not.toMatch(/exit 1/);
		expect(
			scope,
			"scope must come from the pushed range, not from a PR merge ref. Fix: pipe `git diff --name-only \"$PUSHED_BEFORE\" \"$PUSHED_AFTER\"` into scripts/windows-ci-scope.ts.",
		).toMatch(/git diff --name-only "\$PUSHED_BEFORE" "\$PUSHED_AFTER" \| bun scripts\/windows-ci-scope\.ts/);
	});

	// Absence is not success: an out-of-scope merge is a green run that proved nothing,
	// and this line is the only thing separating it from a real proof.
	it("announces a merge that proved nothing about Windows", () => {
		const announce = stepBlock(
			MAIN_WORKFLOW,
			"Announce a merge that proves nothing about Windows",
			"windows-proof-main.yml",
		);
		expect(
			announce,
			"the pinned ::warning moved — update the string here; the workflow is probably fine. It exists because a green run that dispatched nothing must not read as a proof.",
		).toMatch(/::warning title=Windows proof::.*DELIBERATELY NOT DISPATCHED/);
		expect(
			announce,
			"the warning must say what was NOT proved rather than that something was skipped. Fix: re-pin the wording here if it was reworded on purpose.",
		).toMatch(/nothing was proved about the packaged Windows app/);
		expect(
			announce,
			"the pinned run-summary line moved; update it in this test.",
		).toMatch(/## ⚠️ Windows proof: deliberately not dispatched/);
	});

	it("dispatches the packaging proof only through the scope job's verdict", () => {
		const pkg = jobs(MAIN_WORKFLOW).get("windows_package") ?? "";
		expect(pkg, "the windows_package job vanished; nothing proves Windows post-merge any more").not.toBe("");
		expect(
			pkg,
			"the proof must be the reusable workflow, not a second copy of the packaging jobs. Fix: `uses: ./.github/workflows/windows-conpty-package.yml`.",
		).toMatch(/uses:\s*\.\/\.github\/workflows\/windows-conpty-package\.yml/);
		expect(
			pkg,
			"scope is computed by the windows_scope job; dispatching without reading it either always runs or always skips. Fix: keep `if: needs.windows_scope.outputs.in-scope == 'true'`.",
		).toMatch(/needs\.windows_scope\.outputs\.in-scope == 'true'/);
	});
});

describe("nothing publishes to the updater feed without the Windows proof", () => {
	/**
	 * Publishers are detected BY BEHAVIOUR, not by name: any job that runs an
	 * `aws s3 sync`/`cp`. Naming them would mean this test protects exactly today's
	 * four jobs and silently ignores the per-channel jobs the update-channels work adds.
	 */
	const release = [...jobs(RELEASE_WORKFLOW)];
	/** By the command that uploads. */
	const byCommand = release.filter(([, body]) => /aws s3 (?:sync|cp)\b/.test(body));
	/** By the destination that is uploaded to — independent of how it is spelled. */
	const byBucket = release.filter(([, body]) => /s3:\/\/h0x91b-releases\//.test(body));
	const publishers = release.filter(
		([name]) => byCommand.some(([c]) => c === name) || byBucket.some(([b]) => b === name),
	);

	// TWO detectors, DELIBERATELY REDUNDANT — neither may be deleted as duplication.
	// Each is blind to a different mutation: renaming the upload command hides a job from
	// the first (while the others keep the count non-zero, so the gate silently covers
	// three of four), moving the bucket hides every job from the second. A detector that
	// matches NOTHING must be red, or this whole describe passes by iterating an empty
	// list while the updater feed ships ungated.
	it("detects the publishing jobs by their upload command", () => {
		expect(
			byCommand.length,
			"no publishing jobs detected in release.yml by upload command: the matcher for `aws s3 sync` / `aws s3 cp` found nothing. The gate below would then pass on an empty list. Fix: if publishing moved to another command, teach this matcher the new one — do not delete the assertion.",
		).toBeGreaterThan(0);
	});

	it("detects the publishing jobs by their destination bucket", () => {
		expect(
			byBucket.length,
			"no publishing jobs detected in release.yml by destination: nothing mentions s3://h0x91b-releases/ any more. If the bucket or its prefix moved — update channels, for instance — this detector is now blind and the gate below is decoration. Fix: point it at the new destination.",
		).toBeGreaterThan(0);
	});

	// Publishing is decentralised: each build job syncs its own artifacts, INCLUDING to
	// the bucket root, which is the updater feed. So the proof has to gate the build
	// jobs; gating only `release` would fail the GitHub Release after macOS had already
	// shipped to updater clients.
	it("makes every publishing job depend on the Windows proof", () => {
		const ungated = publishers
			.filter(([, body]) => !/^ {4}needs:.*\bwindows-proof\b/m.test(body))
			.map(([name]) => name);

		expect(
			ungated,
			`These release jobs publish to the updater feed without the packaged Windows proof gating them:\n${ungated.join("\n")}\nEach one runs its own \`aws s3 sync\`, including the sync to the bucket ROOT that feeds the in-app updater, so a Windows failure would land a partial ship wearing a failed release's clothes. Fix: add \`windows-proof\` to that job's \`needs:\` — not to the \`release\` job, which runs after the publishing already happened. See decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md.`,
		).toEqual([]);
	});

	it("runs the proof from the release path itself, not from a stale artifact", () => {
		const proof = jobs(RELEASE_WORKFLOW).get("windows-proof") ?? "";
		expect(
			proof,
			"release.yml has no windows-proof job, so a release can build and publish while the packaged Windows app is broken. Arseny's rule: if it cannot build Windows at version-build time, it should fail there. Fix: call ./.github/workflows/windows-conpty-package.yml from a job named windows-proof.",
		).not.toBe("");
		expect(
			proof,
			"the release-side proof must call the same reusable workflow the post-merge one does, or the two drift. Fix: `uses: ./.github/workflows/windows-conpty-package.yml`.",
		).toMatch(/uses:\s*\.\/\.github\/workflows\/windows-conpty-package\.yml/);
		expect(
			proof,
			"a scope filter on the release-side proof would let a release skip Windows entirely. Fix: leave this job unconditional — scoping belongs to the post-merge workflow only.",
		).not.toMatch(/^ {4}if:/m);
	});
});
