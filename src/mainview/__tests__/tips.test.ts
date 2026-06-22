import { describe, it, expect } from "vitest";
import { selectTip, getAvailableTipsCount, ALL_TIPS, SNOOZE_MS, type TipContext } from "../tips";
import type { TipState } from "../../shared/types";

function freshState(overrides: Partial<TipState> = {}): TipState {
	return { snoozedUntil: 0, seen: {}, rotationIndex: 0, ...overrides };
}

const MAX_SCORE = Math.max(...ALL_TIPS.map((t) => t.score));
const VALID_CONTEXTS: TipContext[] = ["board", "terminal", "diff", "settings", "preparing"];

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

	// --- Context (surface) sorting -------------------------------------------

	it("every tip declares at least one valid context (migration is complete)", () => {
		for (const t of ALL_TIPS) {
			expect(Array.isArray(t.contexts), `${t.id} must have contexts`).toBe(true);
			expect(t.contexts.length, `${t.id} contexts must be non-empty`).toBeGreaterThan(0);
			for (const c of t.contexts) {
				expect(VALID_CONTEXTS, `${t.id} has invalid context ${c}`).toContain(c);
			}
		}
	});

	it("the terminal select-to-copy tip exists, is top-tier and terminal-scoped", () => {
		const copy = ALL_TIPS.find((t) => t.id === "terminal-select-copies");
		expect(copy).toBeDefined();
		expect(copy!.score).toBe(5);
		expect(copy!.contexts).toContain("terminal");
	});

	it("context boosts matching tips to the front (sort, not filter)", () => {
		// With a context supplied, the returned tip must be relevant to that
		// surface as long as any matching tip is still available.
		for (const ctx of VALID_CONTEXTS) {
			for (let i = 0; i < 30; i++) {
				const tip = selectTip(freshState({ rotationIndex: i }), ctx);
				expect(tip, `no tip for context ${ctx}`).not.toBeNull();
				expect(tip!.contexts, `${tip!.id} should match ${ctx}`).toContain(ctx);
			}
		}
	});

	it("picks the highest score WITHIN the matching context first", () => {
		const maxTerminal = Math.max(
			...ALL_TIPS.filter((t) => t.contexts.includes("terminal")).map((t) => t.score),
		);
		for (let i = 0; i < 30; i++) {
			const tip = selectTip(freshState({ rotationIndex: i }), "terminal");
			expect(tip!.contexts).toContain("terminal");
			expect(tip!.score).toBe(maxTerminal);
		}
	});

	it("falls back to non-matching tips once the context pool is exhausted", () => {
		// Mark every terminal-context tip as seen → the surface must still show
		// something (a non-terminal tip), never run dry.
		const now = Date.now();
		const seen: Record<string, number> = {};
		for (const t of ALL_TIPS) if (t.contexts.includes("terminal")) seen[t.id] = now;
		const tip = selectTip(freshState({ seen }), "terminal");
		expect(tip).not.toBeNull();
		expect(tip!.contexts).not.toContain("terminal");
	});
});
