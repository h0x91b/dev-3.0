import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const EN_DIR = path.resolve(__dirname, "../i18n/translations/en");

/**
 * A translation value is "bare" when it names only what is missing with no
 * further context — e.g. "No tasks" or "No active dev3 sessions".
 *
 * The §9a.4 three-part rule (what / why / next-action) requires every bare
 * empty-state view to be paired with a companion hint key so the user
 * understands what the surface is, why it is useful, and what to do next.
 *
 * Search-result states ("No … match …") are excluded: the search query box
 * itself is the exit action and "match" signals the context already.
 * Self-enriched values (those containing " — ") already embed the hint inline.
 *
 * The string "Hint" is assembled at runtime (not spelled out literally) so
 * Tailwind's content-glob doesn't generate any spurious utility class.
 */
const HINT_SUFFIX = ["H", "i", "n", "t"].join("");

/** Extract "key": "value" pairs from a TypeScript translation-object literal. */
function loadEnglishTranslations(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const file of readdirSync(EN_DIR)) {
		if (!file.endsWith(".ts")) continue;
		const text = readFileSync(path.join(EN_DIR, file), "utf8");
		// Match single-line string values (handles \uXXXX escapes, etc.)
		for (const [, key, value] of text.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)) {
			out[key] = value.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
				String.fromCodePoint(parseInt(h, 16)),
			);
		}
	}
	return out;
}

function isBareEmptyState(value: string): boolean {
	return (
		value.startsWith("No ") &&
		value.length <= 40 &&
		!value.includes("match") && // search-result empty states carry their own context
		!value.includes(" — ") // already self-enriched inline
	);
}

describe("empty-state enrichment (§9a.4 three-part empty state)", () => {
	const t = loadEnglishTranslations();

	it("scans a meaningful number of English translation keys", () => {
		expect(Object.keys(t).length).toBeGreaterThan(400);
	});

	it(
		"every .empty key whose value is a bare 'No …' has a companion hint key",
		/**
		 * If a .empty key has a bare value (just "No X"), a user who lands on
		 * that surface gets no guidance.  The companion .emptyHint key provides
		 * the 'why it is useful' + 'what to do next' that §9a.4 requires.
		 *
		 * Self-enriched .empty values (containing " — ") are already complete
		 * and do not need a separate hint key.
		 *
		 * Adding a new `.empty` translation without a hint will break this test.
		 */
		() => {
			const offenders = Object.keys(t)
				.filter((k) => /\.empty$/.test(k))
				.filter((k) => isBareEmptyState(t[k]))
				.filter((k) => !t[k + HINT_SUFFIX]);

			expect(offenders, "bare .empty keys missing a companion hint key").toEqual([]);
		},
	);

	it(
		"view-level 'no-X' collection empty states have companion hint keys",
		/**
		 * These keys name an empty collection on a main surface (board column,
		 * sidebar, settings list).  Unlike inline PR/branch status labels they
		 * occupy the full surface and benefit from the three-part rule.
		 *
		 * Inline labels (task.prNoChecks, createTask.branchNoneFound, …) are
		 * intentionally excluded — they appear in context-rich UI and adding
		 * hints there would be creep rather than enrichment.
		 */
		() => {
			// These are the view-level collection-empty keys the §9a.4 audit
			// identified.  Add new ones here as new board/panel surfaces are built.
			const VIEW_LEVEL_EMPTY_KEYS = [
				"kanban.noTasks",
				"sidebar.noActiveTasks",
				"customColumns.noColumns",
			] as const;

			const offenders = VIEW_LEVEL_EMPTY_KEYS.filter((k) => !t[k + HINT_SUFFIX]);
			expect(offenders, "view-level no-X keys missing a companion hint key").toEqual([]);
		},
	);
});
