/**
 * A UTF-8 file re-saved as if it were Latin-1 turns every em dash and arrow into
 * two mangled characters, and nothing fails: the file is still valid UTF-8 and
 * TypeScript compiles it. That is exactly how 46 mangled characters — two of them
 * inside DEFAULT_REVIEW_PROMPT, which every project's AI review agent reads —
 * rode into src/shared/types.ts unnoticed and shipped.
 * See decisions/2026/08/31/guard-against-double-encoded-utf8.md.
 *
 * Every pattern here is written with \u escapes on purpose: a literal example
 * would make this file trip its own guard.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Runs of C2/C3 lead bytes — how double-encoded UTF-8 always looks. A run counts
 * as mojibake only once re-decoding it through Latin-1 yields printable text,
 * which leaves genuine Latin-1 characters (degree, section, middot) alone.
 */
const RUN = /(?:[\u00c2\u00c3][\u0080-\u00bf])+/g;

const TEXT_FILE = /\.(ts|tsx|js|jsx|css|html|json|md|yml|yaml|sh|ps1)$/;

function trackedTextFiles(): string[] {
	const ls = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
	if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
	return ls.stdout.split("\0").filter((path) => path && TEXT_FILE.test(path));
}

/** Reads a string's code units back as bytes and decodes them as UTF-8, or null. */
function undoLatin1(text: string): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff),
		);
	} catch {
		return null;
	}
}

/** Each mojibake run in `path`, rendered as "mangled -> intended". */
function mojibake(path: string): string[] {
	const latin1 = readFileSync(`${REPO}/${path}`, "latin1");
	const found: string[] = [];
	for (const [run] of latin1.matchAll(RUN)) {
		const asWritten = undoLatin1(run);
		const intended = asWritten === null ? null : undoLatin1(asWritten);
		if (intended === null || /\p{C}/u.test(intended)) continue;
		found.push(`${asWritten} -> ${intended}`);
	}
	return found;
}

describe("source text encoding", () => {
	it("carries no double-encoded UTF-8", () => {
		const offenders = trackedTextFiles()
			.map((path) => ({ path, runs: mojibake(path) }))
			.filter(({ runs }) => runs.length > 0)
			.map(({ path, runs }) => `${path}: ${runs.join(", ")}`);
		expect(
			offenders,
			"Cause: the file was written by a tool that read UTF-8 as Latin-1, so its punctuation " +
				"is now two characters wide. It still compiles, so only the rendered text reveals it.\n" +
				"Fix: replace each mangled run with the character shown after the arrow.",
		).toEqual([]);
	});

	it("detects the mangling it guards against", () => {
		// The six bytes an em dash becomes after one Latin-1 round trip.
		const mangled = "\u00c3\u00a2\u00c2\u0080\u00c2\u0094";
		const asWritten = undoLatin1(mangled);
		expect(asWritten).not.toBeNull();
		expect(undoLatin1(asWritten as string)).toBe("—");
	});
});
