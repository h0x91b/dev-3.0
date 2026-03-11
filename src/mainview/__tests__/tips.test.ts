import { describe, it, expect } from "vitest";
import { selectTip, getAvailableTipsCount, ALL_TIPS, SNOOZE_MS } from "../tips";
import type { TipState } from "../../shared/types";

function freshState(overrides: Partial<TipState> = {}): TipState {
	return { snoozedUntil: 0, seen: {}, rotationIndex: 0, ...overrides };
}

describe("tips", () => {
	it("returns a tip with fresh state", () => {
		const tip = selectTip(freshState());
		expect(tip).not.toBeNull();
		expect(tip!.id).toBe(ALL_TIPS[0].id);
	});

	it("returns a different tip when rotationIndex advances", () => {
		const tip0 = selectTip(freshState({ rotationIndex: 0 }));
		const tip1 = selectTip(freshState({ rotationIndex: 1 }));
		expect(tip0).not.toBeNull();
		expect(tip1).not.toBeNull();
		expect(tip0!.id).not.toBe(tip1!.id);
	});

	it("skips tips that are on cooldown", () => {
		const now = Date.now();
		const state = freshState({ seen: { [ALL_TIPS[0].id]: now }, rotationIndex: 0 });
		const tip = selectTip(state);
		expect(tip).not.toBeNull();
		// Should skip the first tip (on cooldown) and pick from remaining
		expect(tip!.id).not.toBe(ALL_TIPS[0].id);
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

	it("rotationIndex wraps around available tips", () => {
		const state = freshState({ rotationIndex: ALL_TIPS.length + 2 });
		const tip = selectTip(state);
		expect(tip).not.toBeNull();
		expect(tip!.id).toBe(ALL_TIPS[2].id);
	});
});
