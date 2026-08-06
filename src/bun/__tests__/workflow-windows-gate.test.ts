/**
 * Tripwires for the gate that makes the required `test` context wait for the
 * packaged Windows proof (decisions/209-required-checks-wait-for-windows-packaging.md —
 * named by full slug on purpose; bare record numbers collided three times in one day).
 *
 * The pins on `build.yml`'s gate step live here too, once that step exists.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_WORKFLOW = fileURLToPath(
	new URL("../../../.github/workflows/windows-conpty-package.yml", import.meta.url),
);
const BUILD_WORKFLOW = fileURLToPath(new URL("../../../.github/workflows/build.yml", import.meta.url));

/** The `run:` body of one named step, comments stripped — same shape as the sibling gate test. */
function stepBlock(workflow: string, name: string): string {
	const lines = workflow.split("\n");
	const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+name:\\s*${name}\\s*$`).test(line));
	expect(start, `step "${name}" is missing from build.yml`).toBeGreaterThanOrEqual(0);
	const block: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*-\s+(name|uses):/.test(line)) break;
		if (!line.trim().startsWith("#")) block.push(line);
	}
	return block.join("\n");
}

/** Job-level keys only: two spaces of body indent under a top-level job key. */
function jobLevelKeys(yaml: string, key: string): string[] {
	const found: string[] = [];
	let job = "";
	for (const line of yaml.split(/\r?\n/)) {
		const jobStart = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (jobStart) job = jobStart[1];
		if (new RegExp(`^ {4}${key}:`).test(line)) found.push(job);
	}
	return found;
}

describe("packaged Windows workflow, called by the required test context", () => {
	const yaml = readFileSync(PACKAGE_WORKFLOW, "utf8");

	// The gate reads the CALLER job's result. A called workflow whose internal job
	// skips still reports success to its caller, so a job-level `if:` in here would
	// let the gate pass on a package that never packaged — the absence-looks-like-
	// success hole, one level deeper where the gate cannot see it. Scope belongs in
	// WINDOWS_SCOPE_PATHS, which the caller evaluates and the gate cross-checks.
	it("has no job-level if:, which the gate could not see through", () => {
		expect(
			jobLevelKeys(yaml, "if"),
			"A job-level `if:` here can skip silently while the caller still reports success. Put the condition in WINDOWS_SCOPE_PATHS instead — see decisions/209-required-checks-wait-for-windows-packaging.md.",
		).toEqual([]);
	});

	it("has no job-level continue-on-error, which would hide a failed package", () => {
		expect(jobLevelKeys(yaml, "continue-on-error")).toEqual([]);
	});

	it("is reusable and owns no trigger of its own", () => {
		// A second copy of the scope list is the drift this design exists to prevent, and
		// its own pull_request trigger would run the packaging jobs twice per PR.
		expect(yaml, "the packaging workflow must be callable from build.yml").toMatch(
			/^\s{2}workflow_call:/m,
		);
		expect(
			/^\s{2}pull_request:/m.test(yaml),
			"scope lives in WINDOWS_SCOPE_PATHS now — a paths filter here would be a second, drifting copy of it",
		).toBe(false);
	});
});

describe("the Windows packaging gate step in build.yml", () => {
	const build = readFileSync(BUILD_WORKFLOW, "utf8");
	const gate = stepBlock(build, "Verify the Windows packaging gate");

	it("reads scope and package results rather than assuming either ran", () => {
		expect(gate).toMatch(/WINDOWS_SCOPE_RESULT:\s*\$\{\{\s*needs\.windows_scope\.result\s*\}\}/);
		expect(gate).toMatch(
			/WINDOWS_IN_SCOPE:\s*\$\{\{\s*needs\.windows_scope\.outputs\.in-scope\s*\}\}/,
		);
		expect(gate).toMatch(/WINDOWS_PACKAGE_RESULT:\s*\$\{\{\s*needs\.windows_package\.result\s*\}\}/);
	});

	// THE artifact holding the absence branch open. If this fails, the pinned string
	// moved — update it here; the gate is almost certainly fine.
	it("announces a deliberately-undispatched proof instead of passing it in silence", () => {
		const absence = gate.slice(gate.indexOf('WINDOWS_IN_SCOPE" != "true"'));
		expect(
			absence,
			'the out-of-scope branch is missing — if the gate was reshaped, re-pin the strings here rather than widening this test',
		).not.toBe("");
		expect(absence, "the pinned ::warning moved; update the string in this test").toMatch(
			/::warning title=Windows packaging gate::.*DELIBERATELY NOT DISPATCHED/,
		);
		expect(
			absence,
			"the warning must say what was NOT proved, not merely that something was skipped",
		).toMatch(/nothing was proved about the packaged Windows app/);
		expect(absence, "the pinned run-summary line moved; update it in this test").toMatch(
			/## ⚠️ Windows packaging gate: deliberately not dispatched/,
		);
		expect(
			absence.slice(absence.indexOf("::warning")),
			"a deliberately-undispatched proof must PASS — failing it reds the required context on roughly one PR in five and blocks the repo",
		).toMatch(/exit 0/);
	});

	it("passes an undispatched proof only when scope independently says out of scope", () => {
		// Cross-check: a skip for any other reason must not read as a deliberate one.
		const absence = gate.slice(gate.indexOf('WINDOWS_IN_SCOPE" != "true"'));
		expect(
			absence,
			"an out-of-scope pass must verify the packaging jobs were actually skipped",
		).toMatch(/WINDOWS_PACKAGE_RESULT" != "skipped"/);
	});

	it("fails hard when the scope job could not decide", () => {
		const undecided = gate.slice(0, gate.indexOf('WINDOWS_IN_SCOPE" != "true"'));
		expect(undecided).toMatch(/WINDOWS_SCOPE_RESULT" != "success"/);
		expect(undecided, "a gate that cannot compute scope must never assume out of scope").toMatch(
			/exit 1/,
		);
	});

	it("fails when the proof was in scope and did not succeed", () => {
		const inScope = gate.slice(gate.lastIndexOf('WINDOWS_PACKAGE_RESULT" != "success"'));
		expect(inScope).toMatch(/::error title=Windows packaging gate::/);
		expect(inScope).toMatch(/exit 1/);
	});

	it("does not swallow the other gates, and is not swallowed by them", () => {
		expect(gate).toMatch(/continue-on-error:\s*true/);
		const final = stepBlock(build, "Fail if any gate is red");
		expect(final).toMatch(/steps\.windows_gate\.outcome/);
	});

	it("refuses to guess scope when the checkout is not a pull_request merge ref", () => {
		const scope = stepBlock(build, "Decide whether the packaged Windows proof is in scope");
		expect(scope).toMatch(/git rev-parse --verify -q HEAD\^2/);
		expect(scope, "a wrong base means a wrong scope; fail instead of guessing").toMatch(/exit 1/);
		expect(scope).toMatch(/git diff --name-only HEAD\^1 HEAD \| bun scripts\/windows-ci-scope\.ts/);
	});
});
