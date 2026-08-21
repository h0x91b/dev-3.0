/**
 * `docs/ux/` is read in full by the `ux-principal` skill, so its size is a per-feature
 * token cost. Prose alone did not hold it: the July 2026 diet cut the tree to 131 KB and
 * wrote a ~35 KB cap on the decision log, and seven weeks later it was 307 KB with the
 * log at 92 KB and a per-feature plan file back on disk. The budget is asserted here.
 * See decisions/2026/08/21/split-ux-principal-from-the-better-skills.md.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UX_DIR = fileURLToPath(new URL("../../../docs/ux", import.meta.url));

/**
 * A ratchet, not a target: each number is the file's size when the budget landed plus about
 * one entry's worth of room, so a single legitimate rule does not have to compact first.
 * Lowering one is always welcome. Raising one is a decision — compact the file, and if it
 * genuinely must grow, say why in the record above.
 *
 * The compaction duty is still owed: 91 of the 106 `UX_DECISIONS.md` entries are over that
 * file's own ~600-character cap and hold 85 KB between them. This budget stops the growth;
 * it does not pretend the file is compact.
 */
const BUDGET_KB: Record<string, number> = {
	"PRODUCT_UX_BIBLE.md": 112,
	"ux-architecture.yaml": 102,
	"UX_DECISIONS.md": 94,
};

/** The whole tree, so a new file cannot slip past a per-file budget. */
const TOTAL_BUDGET_KB = 308;

const entries = readdirSync(UX_DIR, { withFileTypes: true });
const kb = (name: string) => statSync(`${UX_DIR}/${name}`).size / 1024;

describe("docs/ux budget", () => {
	it("holds exactly the three canonical manifest files", () => {
		const unexpected = entries
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.filter((name) => !(name in BUDGET_KB));
		expect(
			unexpected,
			"Cause: per-feature plans, audit reports and manifest changelogs were deleted once already — they are never re-read and they churn every diff.\n" +
				"Fix: the UX plan is chat/PR output. A durable rule belongs in PRODUCT_UX_BIBLE.md or ux-architecture.yaml; its why belongs in UX_DECISIONS.md.\n" +
				`Unexpected: ${unexpected.join(", ")}`,
		).toEqual([]);
	});

	it.each(Object.entries(BUDGET_KB))("keeps %s under its budget", (name, budget) => {
		const actual = kb(name);
		expect(
			actual <= budget,
			`${name} is ${actual.toFixed(1)} KB, over its ${budget} KB budget.\n` +
				"Cause: every planning run reads this file, so growth is a recurring token cost.\n" +
				"Fix: compact it — absorb settled decisions into the bible and shrink their log entries to a dated pointer. Do not raise the number to match reality.",
		).toBe(true);
	});

	it("keeps the whole tree under its budget", () => {
		const total = entries.filter((entry) => entry.isFile()).reduce((sum, entry) => sum + kb(entry.name), 0);
		expect(
			total <= TOTAL_BUDGET_KB,
			`docs/ux is ${total.toFixed(1)} KB, over its ${TOTAL_BUDGET_KB} KB budget. Compact before adding.`,
		).toBe(true);
	});
});
