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
/**
 * `PRODUCT_UX_BIBLE.md` went 122 → 123 for the §10 blast-radius row (a dialog that touches the
 * user's own repo states what it writes and what it pushes). Compaction ran first and only bought
 * ~200 bytes: §5.4a's walk-through evidence, which its record already held. The rest of the file's
 * fat is §10 rows whose why exists nowhere else — deleting those is the failure the note below
 * warns about, so the file grew by the size of one new rule instead. `TOTAL_BUDGET_KB` is
 * deliberately untouched: the tree cap is what actually bounds the per-feature token cost, and the
 * log entry for this rule is a one-line pointer so it still fits.
 *
 * 124 → 125 when §5.4b's tour rules were rewritten after the first live run: a pointing-only
 * overlay let the user click past its own step, so "a step points" split into two rules (it owns
 * the screen, and its button presses the real control) and the lost-anchor rule gained the
 * restart-or-leave state. Compaction ran three times inside §5.4b first and bought ~230 bytes —
 * two bullets merged, the intro shortened — leaving the section 57 bytes over. The rest of the
 * file is §10 rows whose why exists nowhere else.
 */
const BUDGET_KB: Record<string, number> = {
	"PRODUCT_UX_BIBLE.md": 128,
	"ux-architecture.yaml": 114,
	"UX_DECISIONS.md": 80,
};

/**
 * The whole tree, so a new file cannot slip past a per-file budget.
 *
 * Re-ratcheted 306 → 309 when first-run doctrine landed (bible §5.4a), and the reason is the
 * zero-slack failure the comment above predicts: `main` had reached 305.1 KB of 306, so the tree
 * cap was firing on any addition at all while every per-file cap still had room. Compaction ran
 * first and hit the floor — `UX_DECISIONS.md` now folds 26 record-backed entries instead of 24
 * (the 2026-08-21 prompt-preset entry was still carrying prose its record already held), and
 * §5.4a is five rules with its why in `decisions/2026/08/22/first-run-advertises-help-mode.md`.
 * The three per-file numbers are deliberately untouched.
 *
 * 309 → 310 for the §5.4a rule that a first-run-only action lives in the first-run strip rather
 * than beside the screen's primary action. Compaction was attempted first and found nothing: every
 * record-backed entry in `UX_DECISIONS.md` is already a one-line pointer (the longest remaining
 * entries carry a why that exists nowhere else, which the note above forbids deleting), so the
 * tree was genuinely at 309.3 of 309 with no fat left. The new log entry is itself a pointer.
 */
/**
 * 310 → 313, the bible 123 → 124 and the yaml 110 → 111, for §5.4b + the `guided_tour` surface.
 *
 * Compaction ran first and this time it found something real, which is why the ratchet is 3 KB and
 * not 4: §5.4a's "multi-step tours are no longer banned as a class", the yaml's `reject` comment
 * saying the same, and the 2026-08-22 log entry's copy of it are all superseded by §5.4b existing,
 * so all three folded. Beyond that it is the floor the note above describes — every record-backed
 * entry in `UX_DECISIONS.md` is already a pointer, and the remaining full entries carry whys that
 * exist nowhere else. What earned the rest is that a tour is a new SURFACE TYPE rather than another
 * rule about an existing one: with no manifest entry, the next agent adding a walk-through invents a
 * second mechanism — precisely the drift this tree exists to stop. The new log entry is a pointer.
 */
/**
 * 313 → 319, the bible 125 → 128 and the yaml 111 → 113, for §5.9 + the `agent_traffic_log` surface
 * and the `agent_traffic_readout` header slot.
 *
 * The bible's third KB is the one this note has to justify, because §5.9 was written twice: the
 * first ruling (a glyph present while a pair spoke in the last hour) was rejected on sight of it
 * running, and the replacement — kebab home, bar slot earned by unread, never on a phone bar — is
 * strictly more rule per surface. Compaction ran on §5.9 itself three times before this bump and
 * bought ~1.4 KB (the retention/evidence lines folded, the phone rationale stated once instead of
 * twice, the unread mechanics merged into the home bullet); the remaining 110 bytes could only come
 * out of the rulings themselves, which the note above forbids deleting.
 *
 * Compaction was attempted first and found nothing new: the entries this tree still carries in full
 * are the ones whose why exists nowhere else, and every record-backed entry is already a pointer.
 * What earns the ratchet is the same thing §5.4b earned it for — a new SURFACE, not another rule
 * about an existing one. Two rulings here are the kind an agent re-litigates from scratch without a
 * manifest entry: that a header readout may be CONDITIONAL rather than spending the one permanent
 * ambient slot, and that a log with a 30-day history is still an overlay rather than a ninth
 * destination. The new log entry is itself a pointer to `decisions/2026/08/25/`.
 */
/**
 * 319 → 320 and the yaml 113 → 114, for the rule that the agent-traffic feature is gated behind an
 * experimental setting and that OFF means invisible rather than greyed out.
 *
 * Compaction ran first and bought ~200 bytes inside the two agent-traffic entries: the readout's
 * localStorage key and the phone sheet's "28 GB / 5.8 ms" example are implementation detail the
 * bible and the code already carry, and the log's `note` was restating its own forbidden-filter
 * rule twice. That covered half the addition; the rest is the rule itself.
 *
 * What earns the KB is that "hidden, not disabled" contradicts the mechanism the native menu
 * already has — `meetsContext` greys items out, which is right for "no task selected" and wrong for
 * a feature the user switched off. Without the entry the next agent adding a flagged surface
 * reaches for the disable path and ships a permanently dead row. The why in full lives in
 * `decisions/2026/08/26/gate-agent-traffic-behind-an-experimental-setting.md`.
 */
const TOTAL_BUDGET_KB = 320;

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
