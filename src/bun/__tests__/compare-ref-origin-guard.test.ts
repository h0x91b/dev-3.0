/**
 * A handler may not invent `origin/<base>` on its own.
 *
 * The Seq 1642 bug was not a typo — it was one more call site quietly building
 * its own comparison ref while `resolveCompareRef` existed two files away, and
 * nothing in the suite noticed because every test asserted the resolver. This
 * guard is the structural half: writing `origin/${...base...}` inside a handler
 * or a lifecycle activity turns the suite red unless the line carries an explicit
 * `remote-base-ok:` justification.
 *
 * It does NOT make the mistake impossible — a determined caller can still add the
 * marker. It makes it a deliberate act with a written reason instead of a habit.
 *
 * `src/bun/git.ts` is deliberately out of scope: it IS the resolver, and remote
 * refs are its subject matter.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
	join(import.meta.dirname, "..", "rpc-handlers"),
	join(import.meta.dirname, "..", "lifecycle"),
];

/** `origin/${anythingWithBaseInTheName}` — a comparison base, not a task branch. */
const OFFENCE = /`origin\/\$\{[^}]*[Bb]ase[^}]*\}/;
const EXEMPTION = /remote-base-ok:/;

function tsFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : tsFiles(path);
		return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
	});
}

/** A line that continues the statement above it rather than starting one. */
const CONTINUATION = /^([?:.]|&&|\|\||\)|\]|})/;

/**
 * Is the marker in the comment block that introduces this statement? Walks up
 * through the statement's own continuation lines first — a ternary chain puts the
 * offending ref three lines below the comment that justifies it.
 */
function justifiedAbove(lines: string[], index: number): boolean {
	// Walk to the head of the statement the offence sits in — a ternary chain puts
	// the ref three lines below the comment. Only THIS statement's own continuation
	// lines are crossed, so a marker cannot shelter the statement that follows it.
	let head = index;
	while (head > 0 && CONTINUATION.test(lines[head].trimStart())) head--;

	for (let i = head; i >= 0; i--) {
		const line = lines[i].trimStart();
		if (EXEMPTION.test(line)) return true;
		if (i === head) continue;
		if (!line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*")) return false;
	}
	return false;
}

export function unjustifiedOriginBases(files: string[]): string[] {
	const hits: string[] = [];
	for (const file of files) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			// A comment ABOUT the bug is not an occurrence of it.
			if (!OFFENCE.test(line) || line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
			// The marker may sit anywhere in the comment block directly above, so a
			// multi-line reason reads naturally instead of being crammed onto one line.
			if (EXEMPTION.test(line) || justifiedAbove(lines, index)) return;
			hits.push(`${file.slice(file.indexOf("src/"))}:${index + 1}: ${line.trim()}`);
		});
	}
	return hits;
}

describe("comparison base is resolved, never spelled", () => {
	it("finds no handler or activity gluing origin/ onto a base branch", () => {
		expect(unjustifiedOriginBases(ROOTS.flatMap(tsFiles))).toEqual([]);
	});

	it("still catches one when it is added", () => {
		// The guard proving itself: the same detector over a synthetic source line.
		const offending = "\tconst ref = `origin/${baseBranch}`;\n";
		const lines = offending.split("\n");
		expect(OFFENCE.test(lines[0])).toBe(true);
		expect(EXEMPTION.test(lines[0])).toBe(false);
	});
});
