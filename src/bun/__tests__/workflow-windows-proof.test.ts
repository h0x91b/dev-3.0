/**
 * Tripwires for the packaged Windows proof: where it runs, where it must NOT run, and
 * what it has to gate before anything publishes.
 *
 * The proof briefly gated pull requests
 * (decisions/209-required-checks-wait-for-windows-packaging.md — full slugs on purpose,
 * bare record numbers collided four times in one day). That cost +4m47 on every
 * in-scope PR and was reversed: it now runs post-merge on `main` and in front of the
 * release's publishing jobs. See
 * decisions/211-windows-proof-post-merge-not-pull-request.md.
 *
 * These read workflow YAML as raw text, like their siblings — `yaml` is not a declared
 * dependency. Every assertion here must fail naming the CAUSE and the FIX, because a
 * text pin trips on any reshaping and a message that merely restates the invariant
 * sends the next reader after a phantom regression.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const workflow = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)), "utf8");

const PACKAGE_WORKFLOW = workflow("windows-conpty-package.yml");
const MAIN_WORKFLOW = workflow("windows-proof-main.yml");
const BUILD_WORKFLOW = workflow("build.yml");

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
			"A job-level `if:` here skips silently while the workflow still reports success to its caller, so a release could publish on a package that never packaged. Fix: express scope in WINDOWS_SCOPE_PATHS, which the caller evaluates — see decisions/211-windows-proof-post-merge-not-pull-request.md.",
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
			"a pull_request trigger here puts the ~5-minute packaging cost back on every PR, which is exactly what decisions/211-windows-proof-post-merge-not-pull-request.md removed. Fix: leave the trigger to the callers.",
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
			"build.yml runs on pull_request, so calling the packaging workflow from here charges every in-scope PR ~+4m47 on the required `test` context (measured on run 31083965892) — the cost that decisions/211-windows-proof-post-merge-not-pull-request.md reversed. Fix: leave the proof to windows-proof-main.yml and release.yml.",
		).toBe(false);
	});

	it("leaves no Windows gate behind in the required test context", () => {
		const test = jobs(BUILD_WORKFLOW).get("test") ?? "";
		expect(test, "the `test` job vanished from build.yml; this test needs it").not.toBe("");
		expect(
			/windows/i.test(test),
			"the required `test` context references Windows again. Either the proof is gating PRs once more, or a dead reference to the deleted gate survived. Fix: PR-side Windows gating was removed on purpose — see decisions/211-windows-proof-post-merge-not-pull-request.md.",
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
			"a pull_request trigger here re-charges PRs for the proof, undoing decisions/211-windows-proof-post-merge-not-pull-request.md. Fix: keep this workflow post-merge only.",
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

/**
 * Publishers are detected BY BEHAVIOUR across EVERY workflow, and now across workflow_call
 * INDIRECTION: the per-platform builds moved into reusable workflows, so the job that runs
 * `aws s3 sync` lives in one file while the `needs: windows-proof` edge that guards it lives
 * in its caller. A per-file detector then finds a publisher with no edge (false red) or —
 * worse — finds no publisher at all and passes on an empty set.
 *
 * TWO INDEPENDENT PROPERTIES hang off this one enumeration, and they are asserted
 * SEPARATELY over the same set:
 *   A. every publisher is gated by the packaged Windows proof;
 *   B. every publisher is gated by `publish`, so a dry run cannot reach the live feed.
 * They will look redundant to someone later. THEY ARE NOT — a publisher can carry the
 * Windows edge and still publish from a `test-*` tag, and vice versa. Deleting either as
 * duplication is how one of them dies.
 */
describe("nothing publishes to the updater feed without the Windows proof", () => {
	const WORKFLOWS_DIR = fileURLToPath(new URL("../../../.github/workflows", import.meta.url));

	interface Publisher {
		/** File the publishing step lives in. */
		file: string;
		/** Job inside that file. */
		job: string;
		body: string;
		/** True when the publisher sits in a reusable workflow, so its callers guard it. */
		reusable: boolean;
	}

	function allWorkflows(): Array<{ file: string; yaml: string }> {
		return readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
			.filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
			.map((e) => ({ file: e.name, yaml: readFileSync(join(WORKFLOWS_DIR, e.name), "utf8") }));
	}

	/** By the command that uploads, and independently by the destination uploaded to. */
	const byCommand: Publisher[] = [];
	const byBucket: Publisher[] = [];
	for (const { file, yaml } of allWorkflows()) {
		const reusable = /^\s{2}workflow_call:/m.test(yaml);
		for (const [job, body] of jobs(yaml)) {
			if (/aws s3 (?:sync|cp)\b/.test(body)) byCommand.push({ file, job, body, reusable });
			if (/s3:\/\/h0x91b-releases\//.test(body)) byBucket.push({ file, job, body, reusable });
		}
	}
	const publishers = [...byCommand, ...byBucket].filter(
		(p, i, all) => all.findIndex((q) => q.file === p.file && q.job === p.job) === i,
	);

	/** Every job in any workflow that calls `file` via `uses:`. */
	function callersOf(file: string): Array<{ file: string; job: string; body: string }> {
		const found: Array<{ file: string; job: string; body: string }> = [];
		for (const { file: caller, yaml } of allWorkflows()) {
			for (const [job, body] of jobs(yaml)) {
				if (body.includes(`uses: ./.github/workflows/${file}`)) found.push({ file: caller, job, body });
			}
		}
		return found;
	}

	// TWO detectors, DELIBERATELY REDUNDANT — neither may be deleted as duplication. Each is
	// blind to a different mutation: renaming the upload command hides a job from the first,
	// moving the bucket hides every job from the second. A detector that matches NOTHING must
	// be red, or this whole describe passes by iterating an empty list while the feed ships
	// ungated. The extraction of the per-platform builds is exactly the change that emptied
	// the old release.yml-only version of this set.
	it("detects the publishing jobs by their upload command", () => {
		expect(
			byCommand.length,
			"no publishing jobs detected in ANY workflow by upload command: the matcher for `aws s3 sync` / `aws s3 cp` found nothing, so every assertion below passes on an empty list. Fix: if publishing moved to another command, teach this matcher the new one — do not delete the assertion.",
		).toBeGreaterThan(0);
	});

	it("detects the publishing jobs by their destination bucket", () => {
		expect(
			byBucket.length,
			"no publishing jobs detected in ANY workflow by destination: nothing mentions s3://h0x91b-releases/ any more. If the bucket or its prefix moved, this detector is now blind and everything below is decoration. Fix: point it at the new destination.",
		).toBeGreaterThan(0);
	});

	// PROPERTY A. Publishing is decentralised: each build job syncs its own artifacts,
	// INCLUDING to the bucket root that feeds the in-app updater. A publisher inside a
	// reusable workflow is guarded by its CALLERS, and EVERY caller must carry the edge —
	// one unguarded caller is a full publish path.
	it("makes every publishing job depend on the Windows proof", () => {
		const ungated: string[] = [];
		for (const p of publishers) {
			if (!p.reusable) {
				if (!/^ {4}needs:.*\bwindows-proof\b/m.test(p.body)) ungated.push(`${p.file} job ${p.job}`);
				continue;
			}
			const callers = callersOf(p.file);
			if (callers.length === 0) {
				ungated.push(`${p.file} job ${p.job} (reusable, but nothing calls it — it cannot be guarded)`);
				continue;
			}
			for (const c of callers) {
				if (!/^ {4}needs:.*\bwindows-proof\b/m.test(c.body)) {
					ungated.push(`${c.file} job ${c.job} calls ${p.file} without the proof`);
				}
			}
		}

		expect(
			ungated,
			`These publish to the updater feed without the packaged Windows proof gating them:\n${ungated.join("\n")}\nEach runs its own \`aws s3 sync\`, including the sync to the bucket ROOT that feeds the in-app updater, so a Windows failure would land a partial ship wearing a failed release's clothes. A publisher inside a REUSABLE workflow is guarded by its callers, so EVERY caller needs the edge. Fix: add \`windows-proof\` to that job's \`needs:\`. See decisions/211-windows-proof-post-merge-not-pull-request.md.`,
		).toEqual([]);
	});

	// PROPERTY B, and the reason it exists is a near miss. The dry-run containment was
	// PER-STEP — `if: needs.prepare.outputs.publish == 'true'` on the upload step — and a
	// reusable workflow CANNOT read its caller's `needs` context. Moving those steps without
	// re-gating them would have turned every `test-*` dry run into a live publish to the feed
	// real users poll, silently, with the run still green.
	it("gates every publishing step so a dry run cannot reach the live feed", () => {
		const ungated: string[] = [];
		for (const p of publishers) {
			const guarded = p.reusable
				? /^ {8}if:\s*inputs\.publish\s*$/m.test(p.body)
				: /^ {8}if:\s*needs\.prepare\.outputs\.publish == 'true'\s*$/m.test(p.body);
			if (!guarded) ungated.push(`${p.file} job ${p.job}`);
		}

		expect(
			ungated,
			`These publishing steps are not gated, so a dry run (a \`test-*\` tag or workflow_dispatch) would publish to the LIVE updater feed:\n${ungated.join("\n")}\nFix: in a caller, gate the upload step with \`if: needs.prepare.outputs.publish == 'true'\`; in a reusable workflow, take \`publish\` as a required boolean input and gate with \`if: inputs.publish\`. A reusable workflow cannot read the caller's \`needs\` context, which is why this is an input and not an inherited condition.`,
		).toEqual([]);
	});

	// PROPERTY B, one level up. A job output is a STRING — release.yml compares it to
	// 'true' for exactly that reason. Passing the raw output to a boolean input means a
	// "false" string arrives truthy, `if: inputs.publish` is satisfied, and the dry run
	// publishes — the identical catastrophe one file over, with the step's `if:` present
	// and correct.
	it("passes publish as an explicit boolean comparison, never a raw output string", () => {
		const bad: string[] = [];
		for (const { file, yaml } of allWorkflows()) {
			for (const [job, body] of jobs(yaml)) {
				// Only a CALL-SITE input counts. `prepare` DECLARES a job output also named
				// `publish` at the same indent, and matching that instead is a false positive
				// — the output is meant to be a string; it is the `with:` value that must be
				// a boolean.
				const withIdx = body.search(/^ {4}with:$/m);
				if (withIdx < 0) continue;
				const m = /^ {6}publish:\s*(.+)$/m.exec(body.slice(withIdx));
				if (!m) continue;
				const value = m[1].trim();
				const ok = /==\s*'true'\s*\}\}$/.test(value) || value === "true" || value === "false";
				if (!ok) bad.push(`${file} job ${job} passes publish: ${value}`);
			}
		}

		expect(
			bad,
			`These call sites pass a non-boolean to the \`publish\` input:\n${bad.join("\n")}\nA job output is a STRING, so a non-empty "false" arrives TRUTHY at a boolean input and the dry run publishes to the live feed with the step's \`if:\` present and correct. Fix: pass \`publish: \${{ needs.prepare.outputs.publish == 'true' }}\` — an explicit comparison — or a literal true/false.`,
		).toEqual([]);
	});
});
