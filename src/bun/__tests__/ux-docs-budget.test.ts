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
 * A ratchet, not a target: each number is the file's size when the budget landed plus a few
 * KB, so a couple of ordinary PRs fit before anyone has to compact. `main` genuinely pushes
 * content into these files every week, and a budget with zero slack would fire on unrelated
 * work; a budget with unlimited slack is the prose cap that already failed.
 * Lowering one is always welcome. Raising one is a decision — compact the file, and if it
 * genuinely must grow, say why in the record above.
 *
 * The guard earned its keep twice before it even merged: #1450 added 6 KB to the bible, then
 * #1451/#1453/#1454/#1455 added another 8 KB across the tree, and each rebase failed loudly.
 *
 * `UX_DECISIONS.md` has been folded once: the 24 entries whose reasoning now lives in
 * `decisions/` are pointers. The other 84 keep their full text because it exists nowhere
 * else — compact those by writing the record first, never by deleting the why.
 */
const BUDGET_KB: Record<string, number> = {
	"PRODUCT_UX_BIBLE.md": 122,
	"ux-architecture.yaml": 110,
	"UX_DECISIONS.md": 80,
};

/** The whole tree, so a new file cannot slip past a per-file budget. */
const TOTAL_BUDGET_KB = 306;

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
