// Property tests over generated rows. Suite A is the mechanical proof that no
// left-to-right language regressed: thousands of rows built only from non-RTL
// clusters, every one of which must skip the reorder entirely.
import type { GhosttyCell } from "ghostty-web";
import { describe, expect, it } from "vitest";
import { reorderRow } from "../reorder";
import { assertRowInvariants, blank, cell, graphemeCell, lcg } from "./fixtures";

type ClusterFactory = () => GhosttyCell[];

const LTR_CLUSTERS: ClusterFactory[] = [
	() => [cell("a")],
	() => [cell("Z")],
	() => [cell("7")],
	() => [cell("-")],
	() => [cell(".")],
	() => [cell("/")],
	() => [cell("|")],
	() => [cell("┌")],
	() => [cell("П")],
	() => [cell("Ω")],
	() => [cell("क")],
	() => [blank()],
	() => [cell("日", { width: 2 }), cell("", { codepoint: 0, width: 0 })],
	() => [graphemeCell("👍🏽", 2), cell("", { codepoint: 0, width: 0 })],
	() => [cell("a"), cell("́", { width: 0 })],
	() => [cell("("), cell(")")],
];

const RTL_CLUSTERS: ClusterFactory[] = [
	() => [cell("א")],
	() => [cell("ב")],
	() => [cell("ا")],
	() => [cell("ب")],
	() => [cell("٣")],
	() => [cell("۱")],
	() => [graphemeCell("שָׁ")],
	() => [cell("\u{1E900}")],
	() => [cell("‏")],
	() => [cell("‮")],
];

/**
 * Only strongly-directional clusters. Neutrals (space, punctuation, box drawing,
 * emoji) and weak digits legitimately join an adjacent run per UAX#9 N1/N2, so
 * they cannot appear in the locality property below.
 */
const STRONG_LTR_CLUSTERS: ClusterFactory[] = [
	() => [cell("a")],
	() => [cell("Z")],
	() => [cell("П")],
	() => [cell("Ω")],
	() => [cell("क")],
	() => [cell("日", { width: 2 }), cell("", { codepoint: 0, width: 0 })],
	() => [cell("a"), cell("́", { width: 0 })],
];

const STRONG_RTL_CLUSTERS: ClusterFactory[] = [
	() => [cell("א")],
	() => [cell("ב")],
	() => [cell("ا")],
	() => [cell("ب")],
	() => [graphemeCell("שָׁ")],
	() => [cell("\u{1E900}")],
];

function build(
	random: () => number,
	pool: ClusterFactory[],
	clusterCount: number,
): GhosttyCell[] {
	const cells: GhosttyCell[] = [];
	for (let i = 0; i < clusterCount; i++) {
		const factory = pool[Math.floor(random() * pool.length)];
		cells.push(...factory());
	}
	return cells;
}

const SEEDS = [1, 42, 1337, 20260803];
const ROWS_PER_SEED = 1250;

describe("reorderRow property tests", () => {
	it.each(SEEDS)(
		"never touches a row without right-to-left content (seed %i)",
		(seed) => {
			const random = lcg(seed);
			for (let i = 0; i < ROWS_PER_SEED; i++) {
				const cells = build(random, LTR_CLUSTERS, 1 + Math.floor(random() * 40));
				expect(reorderRow(cells)).toBeNull();
			}
		},
	);

	it.each(SEEDS)("holds every structural invariant on mixed rows (seed %i)", (seed) => {
		const random = lcg(seed);
		const pool = [...LTR_CLUSTERS, ...RTL_CLUSTERS];
		let reordered = 0;
		for (let i = 0; i < ROWS_PER_SEED; i++) {
			const cells = build(random, pool, 1 + Math.floor(random() * 40));
			const result = reorderRow(cells);
			if (!result) continue;
			reordered++;
			assertRowInvariants(cells, result);
		}
		// Sanity: the generator must actually be exercising the reorder path.
		expect(reordered).toBeGreaterThan(ROWS_PER_SEED / 2);
	});

	it.each(SEEDS)(
		"keeps strongly left-to-right columns fixed around a middle run (seed %i)",
		(seed) => {
		const random = lcg(seed);
		for (let i = 0; i < 200; i++) {
			const prefix = build(random, STRONG_LTR_CLUSTERS, 1 + Math.floor(random() * 6));
			const middle = build(random, STRONG_RTL_CLUSTERS, 1 + Math.floor(random() * 6));
			const suffix = build(random, STRONG_LTR_CLUSTERS, 1 + Math.floor(random() * 6));
			const cells = [...prefix, ...middle, ...suffix];
			const result = reorderRow(cells);
			if (!result) continue;

			assertRowInvariants(cells, result);
			for (let column = 0; column < prefix.length; column++) {
				expect(result.visualToLogical[column]).toBe(column);
			}
			for (let column = prefix.length + middle.length; column < cells.length; column++) {
				expect(result.visualToLogical[column]).toBe(column);
			}
		}
		},
	);
});
