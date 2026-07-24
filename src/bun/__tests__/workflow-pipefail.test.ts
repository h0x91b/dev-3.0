import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
describe("workflow steps that pipe use a pipefail shell", () => {
	for (const workflow of ["build.yml", "windows-conpty-package.yml", "release.yml"]) {
		it(`${workflow} pipes only under an explicit bash shell`, () => {
			const raw = readFileSync(resolve(repoRoot, ".github/workflows", workflow), "utf-8");
			const offenders = steps(raw)
				.filter(({ block }) => /\|\s*tee\b/.test(block))
				.filter(({ block }) => !/^\s*shell:\s*bash\s*$/m.test(block))
				.map(({ name }) => name);
			expect(offenders, `steps piping into tee without \`shell: bash\` in ${workflow}`).toEqual([]);
		});
	}
});
