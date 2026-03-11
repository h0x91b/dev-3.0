import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCurrentTip, dismissTip, advanceTip } from "../tips";

// Mock localStorage
const store = new Map<string, string>();
const localStorageMock = {
	getItem: vi.fn((key: string) => store.get(key) ?? null),
	setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
	removeItem: vi.fn((key: string) => { store.delete(key); }),
	clear: vi.fn(() => store.clear()),
	get length() { return store.size; },
	key: vi.fn(() => null),
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

describe("tips", () => {
	beforeEach(() => {
		store.clear();
		vi.clearAllMocks();
	});

	it("returns a tip when none are dismissed", () => {
		const tip = getCurrentTip();
		expect(tip).not.toBeNull();
		expect(tip!.id).toBeTruthy();
		expect(tip!.titleKey).toBeTruthy();
		expect(tip!.bodyKey).toBeTruthy();
		expect(tip!.icon).toBeTruthy();
	});

	it("returns a different tip after advancing", () => {
		const tip1 = getCurrentTip();
		advanceTip();
		const tip2 = getCurrentTip();
		expect(tip1).not.toBeNull();
		expect(tip2).not.toBeNull();
		expect(tip1!.id).not.toBe(tip2!.id);
	});

	it("does not return a dismissed tip", () => {
		const tip = getCurrentTip();
		expect(tip).not.toBeNull();
		dismissTip(tip!.id);
		const next = getCurrentTip();
		// next should either be null (all dismissed) or a different tip
		if (next) {
			expect(next.id).not.toBe(tip!.id);
		}
	});

	it("returns null when all tips are dismissed", () => {
		// Dismiss all tips one by one
		let tip = getCurrentTip();
		while (tip) {
			dismissTip(tip.id);
			tip = getCurrentTip();
		}
		expect(getCurrentTip()).toBeNull();
	});

	it("advanceTip is a no-op when only one tip remains", () => {
		// Dismiss all but one
		let tip = getCurrentTip();
		const kept = tip!.id;
		while (tip) {
			const next = getCurrentTip();
			if (!next) break;
			// Dismiss all except the first one
			advanceTip();
			const afterAdvance = getCurrentTip();
			if (afterAdvance && afterAdvance.id !== kept) {
				dismissTip(afterAdvance.id);
			} else {
				break;
			}
			tip = getCurrentTip();
		}
		// After advance, should still get the same tip
		const remaining = getCurrentTip();
		advanceTip();
		const stillRemaining = getCurrentTip();
		if (remaining && stillRemaining) {
			expect(remaining.id).toBe(stillRemaining.id);
		}
	});
});
