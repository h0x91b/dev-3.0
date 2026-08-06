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
});
