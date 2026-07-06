import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MakefileScripts, PackageScriptEntry } from "../shared/types";

// GNU make's own lookup order for the default makefile — the first present wins.
const MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"] as const;

// Directive keywords that begin a line but are not rule targets.
const DIRECTIVES = new Set([
	"include",
	"-include",
	"sinclude",
	"ifeq",
	"ifneq",
	"ifdef",
	"ifndef",
	"else",
	"endif",
	"define",
	"endef",
	"override",
	"export",
	"unexport",
	"vpath",
	"undefine",
]);

function emptyResult(error: string | null): MakefileScripts {
	return { exists: false, path: null, targets: [], error };
}

/**
 * Extract runnable targets from a Makefile's text. We deliberately keep this a
 * lightweight, dependency-free line scanner (not a full GNU make parser):
 *
 *  - a rule line is `name [name...]: [prereqs]` starting at column 0;
 *  - variable assignments (`FOO := x`, `FOO = x`, `FOO ?= x`, `FOO += x`,
 *    `FOO ::= x`) are skipped — the `=`-before/after-`:` heuristic distinguishes
 *    them from real rules;
 *  - dot-special targets (`.PHONY`, `.SUFFIXES`, …), pattern rules (`%.o`),
 *    and computed names (`$(x)`, `*`) are skipped;
 *  - the first tab-indented recipe line becomes a human-readable preview.
 *
 * Double-colon rules (`target::`) are treated as normal targets. Targets are
 * de-duplicated (first occurrence wins) and returned in file order.
 */
export function extractMakeTargets(raw: string): PackageScriptEntry[] {
	const lines = raw.split(/\r?\n/);
	const order: string[] = [];
	const preview = new Map<string, string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Recipes and continuations are indented; rule headers sit at column 0.
		if (line.length === 0 || /^\s/.test(line)) continue;
		const trimmedStart = line.replace(/^\s+/, "");
		if (trimmedStart.startsWith("#")) continue;

		const firstWord = trimmedStart.split(/[\s:=]/, 1)[0];
		if (DIRECTIVES.has(firstWord)) continue;

		const colon = line.indexOf(":");
		const eq = line.indexOf("=");
		// No colon → cannot be a rule (assignments like `FOO = x` land here).
		if (colon < 0) continue;
		// `=` before the colon → assignment (`FOO ?= a:b`).
		if (eq >= 0 && eq < colon) continue;
		// `:=`, `::=`, `:::=` immediately after the name → assignment, not a rule.
		if (/^:+=/.test(line.slice(colon))) continue;

		const namePart = line.slice(0, colon);
		const recipe = firstRecipeLine(lines, i);

		for (const rawName of namePart.split(/\s+/)) {
			const name = rawName.trim();
			if (!name) continue;
			if (name.startsWith(".")) continue; // .PHONY, .SUFFIXES, …
			if (/[%$*]/.test(name)) continue; // pattern rules / computed names
			if (!preview.has(name)) {
				order.push(name);
				preview.set(name, recipe);
			} else if (recipe && !preview.get(name)) {
				// Fill in a preview if an earlier declaration had none.
				preview.set(name, recipe);
			}
		}
	}

	return order.map((name) => ({ name, command: preview.get(name) ?? "" }));
}

// First non-blank line after a rule header, if it is a tab-indented recipe.
// Leading recipe modifiers (@ silent, - ignore-errors, + always-run) are stripped
// for a cleaner preview.
function firstRecipeLine(lines: string[], headerIdx: number): string {
	for (let j = headerIdx + 1; j < lines.length; j++) {
		const l = lines[j];
		if (l.trim() === "") continue;
		if (l.startsWith("\t")) {
			return l.replace(/^\t+/, "").replace(/^[@+-]+\s*/, "").trim();
		}
		break; // first non-blank line was not a recipe
	}
	return "";
}

export function parseMakefile(worktreePath: string | null): MakefileScripts {
	if (!worktreePath) return emptyResult("no-worktree");
	let found: string | null = null;
	for (const name of MAKEFILE_NAMES) {
		if (existsSync(join(worktreePath, name))) {
			found = name;
			break;
		}
	}
	if (!found) return emptyResult("no-makefile");
	let raw: string;
	try {
		raw = readFileSync(join(worktreePath, found), "utf-8");
	} catch (err) {
		return emptyResult(`read-failed: ${(err as Error).message}`);
	}
	const targets = extractMakeTargets(raw);
	return {
		exists: true,
		path: found,
		targets,
		error: targets.length === 0 ? "no-targets" : null,
	};
}

/**
 * Build the shell command that runs a Makefile target. The name is validated
 * against the same safe-char allowlist as npm scripts so it can be interpolated
 * into the tmux-wrapped `bash -c '…'` string without shell-injection risk.
 */
export function resolveMakeCommand(target: string): string {
	const safe = target.replace(/[^a-zA-Z0-9:_\-./]/g, "");
	if (safe !== target) {
		throw new Error(`invalid make target: ${target}`);
	}
	return `make ${safe}`;
}
