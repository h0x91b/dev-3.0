/**
 * Every path that looks for Claude transcripts must resolve its roots through
 * `claudeConfigDirs` — the home store PLUS dev3's agent accounts, whose
 * directories dev3 itself injects as `CLAUDE_CONFIG_DIR`.
 *
 * This shipped broken once: both discovery paths read `~/.claude/projects` only,
 * so 40 transcripts across 13 worktrees on the measuring machine were invisible
 * to search and to resume. The adapter's required `configDirs` argument stops it
 * at compile time; this stops a hand-rolled path from sneaking back in.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A store path built by hand, rather than through the shared helpers. */
const HANDROLLED_STORE_PATH = /\.claude\/projects\/(\$\{|["'`+])/;

/** Files allowed to name the layout: the one formula, and prose about it. */
const ALLOWED = new Set([
	"shared/conversation-search-core.ts",
	"shared/conversation-parsers/claude.ts",
	"shared/agent-skill-content.ts",
]);

function sourceFiles(dir: string, prefix = ""): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const rel = prefix ? `${prefix}/${entry}` : entry;
		if (statSync(path).isDirectory()) {
			if (entry === "__tests__" || entry === "node_modules") continue;
			found.push(...sourceFiles(path, rel));
			continue;
		}
		if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(rel);
	}
	return found;
}

describe("Claude transcript discovery", () => {
	it("flags the shape this guard exists for", () => {
		// The literal that shipped in the adapter before agent accounts were handled.
		const before = 'return { dir: `${home}/.claude/projects/${claudeEncodePath(worktreePath)}`, ext: ".jsonl" };';
		expect(HANDROLLED_STORE_PATH.test(before)).toBe(true);
	});

	it("builds every store path through the shared helpers", () => {
		const root = join(import.meta.dirname, "..", "..");
		const offenders = sourceFiles(root)
			.filter((rel) => !ALLOWED.has(rel))
			.filter((rel) => HANDROLLED_STORE_PATH.test(readFileSync(join(root, rel), "utf-8")));

		expect(offenders).toEqual([]);
	});
});
