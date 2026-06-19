import { describe, it, expect } from "vitest";
import { selectTip, getAvailableTipsCount, ALL_TIPS, SNOOZE_MS } from "../tips";
import type { TipState } from "../../shared/types";

function freshState(overrides: Partial<TipState> = {}): TipState {
	return { snoozedUntil: 0, seen: {}, rotationIndex: 0, ...overrides };
}

const MAX_SCORE = Math.max(...ALL_TIPS.map((t) => t.score));

describe("tips", () => {
	it("returns a tip with fresh state", () => {
		const tip = selectTip(freshState());
		expect(tip).not.toBeNull();
	});

	it("every tip has a coolness score in 1..5", () => {
		for (const t of ALL_TIPS) {
			expect(t.score).toBeGreaterThanOrEqual(1);
			expect(t.score).toBeLessThanOrEqual(5);
		}
	});

	it("always picks from the highest available tier first", () => {
		// Across many rotation indexes, a fresh state must always surface a top-tier tip.
		for (let i = 0; i < 50; i++) {
			const tip = selectTip(freshState({ rotationIndex: i }));
			expect(tip).not.toBeNull();
			expect(tip!.score).toBe(MAX_SCORE);
		}
	});

	it("drops to the next tier once the top tier is exhausted", () => {
		const now = Date.now();
		const seen: Record<string, number> = {};
		for (const t of ALL_TIPS) if (t.score === MAX_SCORE) seen[t.id] = now;
		const remainingMax = Math.max(
			...ALL_TIPS.filter((t) => t.score !== MAX_SCORE).map((t) => t.score),
		);
		for (let i = 0; i < 20; i++) {
			const tip = selectTip(freshState({ seen, rotationIndex: i }));
			expect(tip).not.toBeNull();
			expect(tip!.score).toBe(remainingMax);
		}
	});

	it("skips tips that are on cooldown", () => {
		const now = Date.now();
		const topTier = ALL_TIPS.filter((t) => t.score === MAX_SCORE);
		const seen = { [topTier[0].id]: now };
		// The seen top-tier tip must never be returned while on cooldown.
		for (let i = 0; i < 20; i++) {
			const tip = selectTip(freshState({ seen, rotationIndex: i }));
			expect(tip!.id).not.toBe(topTier[0].id);
		}
	});

	it("returns null when snoozed", () => {
		const state = freshState({ snoozedUntil: Date.now() + SNOOZE_MS });
		expect(selectTip(state)).toBeNull();
	});

	it("returns tip when snooze has expired", () => {
		const state = freshState({ snoozedUntil: Date.now() - 1000 });
		expect(selectTip(state)).not.toBeNull();
	});

	it("returns null when all tips are on cooldown", () => {
		const now = Date.now();
		const seen: Record<string, number> = {};
		for (const t of ALL_TIPS) seen[t.id] = now;
		expect(selectTip(freshState({ seen }))).toBeNull();
	});

	it("shows tip again after cooldown expires", () => {
		const expired = Date.now() - 4 * 24 * 60 * 60 * 1000; // 4 days ago
		const seen: Record<string, number> = {};
		for (const t of ALL_TIPS) seen[t.id] = expired;
		const tip = selectTip(freshState({ seen }));
		expect(tip).not.toBeNull();
	});

	it("getAvailableTipsCount returns correct count", () => {
		expect(getAvailableTipsCount(freshState())).toBe(ALL_TIPS.length);
		const now = Date.now();
		expect(getAvailableTipsCount(freshState({ seen: { [ALL_TIPS[0].id]: now } }))).toBe(ALL_TIPS.length - 1);
	});
});
