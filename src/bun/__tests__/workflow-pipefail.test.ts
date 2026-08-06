import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** Split a workflow's steps into `{ name, block }` chunks by their `- name:` line. */
function steps(workflow: string): Array<{ name: string; block: string }> {
	const lines = workflow.split("\n");
	const found: Array<{ name: string; block: string }> = [];
	let current: { name: string; block: string } | null = null;
	for (const line of lines) {
		const start = line.match(/^\s*-\s+name:\s*(.+)$/);
		if (start) {
			if (current) found.push(current);
			current = { name: start[1].trim(), block: "" };
			continue;
		}
		// Comments trailing a step actually introduce the NEXT one, and may quote
		// shell snippets — never let them count as this step's script.
		if (current && !line.trim().startsWith("#")) current.block += `${line}\n`;
	}
	if (current) found.push(current);
	return found;
}

// A `run:` step that pipes MUST opt into pipefail. GitHub's default shell for
// `run:` is `bash -e {0}` (no pipefail), so `cmd | tee log` reports tee's exit
// code — a failing test suite then records `outcome: success` and the sharded
// test gate silently passes. Declaring `shell: bash` gets `-eo pipefail`.
/** Every workflow, derived — never a hardcoded list. */
function workflowFiles(): string[] {
	return readdirSync(resolve(repoRoot, ".github/workflows"), { withFileTypes: true })
		.filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
		.map((e) => e.name)
		.sort();
}

// The list used to be hardcoded as ["build.yml", "windows-conpty-package.yml",
// "release.yml"], which is a COVERAGE CAP disguised as a test: every workflow added after
// it was written was silently unchecked, and a green run never said so. Deriving it also
// means a future workflow is covered the moment it exists rather than when someone
// remembers this file.
//
// BEFORE YOU "SIMPLIFY" THIS BACK TO A LIST, meet the measured numbers: hardcoding it to a
// single file takes this suite from NINE TESTS TO TWO and STILL PASSES GREEN. Nothing
// fails, nothing warns, 78% of the coverage is gone, and the only signal is a test count
// nobody reads. See decisions/221-extract-reusable-release-build-workflows.md.
describe("workflow steps that pipe use a pipefail shell", () => {
	// Zero matches must FAIL: if nothing pipes into tee anywhere, the matcher is dead and
	// every assertion below passes while guarding nothing.
	it("finds piping steps to check at all", () => {
		const piping = workflowFiles().flatMap((workflow) =>
			steps(readFileSync(resolve(repoRoot, ".github/workflows", workflow), "utf-8"))
				.filter(({ block }) => /\|\s*tee\b/.test(block))
				.map(({ name }) => `${workflow}: ${name}`),
		);
		expect(
			piping.length,
			"no steps piping into `tee` found in any workflow. Either the pattern stopped being used, or this matcher no longer matches it — in both cases the check below guards nothing. Fix: teach the matcher the new form; do not delete the assertion.",
		).toBeGreaterThan(0);
	});

	for (const workflow of workflowFiles()) {
		it(`${workflow} pipes only under an explicit bash shell`, () => {
			const raw = readFileSync(resolve(repoRoot, ".github/workflows", workflow), "utf-8");
			const offenders = steps(raw)
				.filter(({ block }) => /\|\s*tee\b/.test(block))
				.filter(({ block }) => !/^\s*shell:\s*bash\s*$/m.test(block))
				.map(({ name }) => name);
			expect(
				offenders,
				`These steps in ${workflow} pipe into \`tee\` without \`shell: bash\`, so the step reports tee's exit code and a failing command reads as success:\n${offenders.join("\n")}\nFix: add \`shell: bash\` to the step (that gets -eo pipefail).`,
			).toEqual([]);
		});
	}
});
