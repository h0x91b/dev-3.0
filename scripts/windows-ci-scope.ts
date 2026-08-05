/**
 * Decides whether a pull request's diff puts the packaged Windows proof in scope,
 * and emits `in-scope` for the `windows_scope` job in `build.yml`.
 *
 * Reads repo-relative changed files from argv or newline-separated stdin. An empty
 * file list is a HARD ERROR, never "out of scope": a gate that cannot compute scope
 * must fail rather than quietly assert Windows was checked-and-not-applicable.
 */

import { appendFileSync } from "node:fs";
import { WINDOWS_SCOPE_PATHS, windowsScopeHits } from "../src/shared/windows-ci-scope";

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

const args = process.argv.slice(2);
const raw = args.length > 0 ? args.join("\n") : await readStdin();
const files = raw
	.split(/\r?\n/)
	.map((line) => line.trim())
	.filter((line) => line.length > 0);

if (files.length === 0) {
	console.error(
		"windows-ci-scope: no changed files were provided, so Windows scope could not be decided. Failing instead of assuming out of scope.",
	);
	process.exit(1);
}

const hits = windowsScopeHits(files);
const inScope = hits.length > 0;

console.log(`changed files: ${files.length}`);
console.log(`scope patterns: ${WINDOWS_SCOPE_PATHS.length} (src/shared/windows-ci-scope.ts)`);
console.log(`in scope: ${inScope}`);
for (const hit of hits) console.log(`  hit: ${hit}`);

const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `in-scope=${inScope}\n`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
	appendFileSync(
		summary,
		inScope
			? `## Windows packaging scope: in scope (${hits.length} of ${files.length} changed files match)\n`
			: `## Windows packaging scope: out of scope (0 of ${files.length} changed files match)\n`,
	);
}
