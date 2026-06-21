import { describe, expect, it } from "vitest";
import { codeToHintChar, DEFAULT_HINT_CHARS, generateHintStrings } from "../hintLabels";

function isPrefixFree(hints: string[]): boolean {
	for (const a of hints) {
		for (const b of hints) {
			if (a !== b && b.startsWith(a)) return false;
		}
	}
	return true;
}

describe("generateHintStrings", () => {
	it("returns an empty array for non-positive counts", () => {
		expect(generateHintStrings(0)).toEqual([]);
		expect(generateHintStrings(-3)).toEqual([]);
	});

	it("produces exactly `count` unique hints", () => {
		for (const count of [1, 5, 14, 26, 27, 100, 700]) {
			const hints = generateHintStrings(count);
			expect(hints).toHaveLength(count);
			expect(new Set(hints).size).toBe(count);
		}
	});

	it("uses only the provided characters", () => {
		const chars = "abcd";
		const hints = generateHintStrings(50, chars);
		for (const h of hints) {
			for (const ch of h) expect(chars).toContain(ch);
		}
	});

	it("never makes one hint a prefix of another", () => {
		for (const count of [1, 10, 26, 27, 53, 200]) {
			expect(isPrefixFree(generateHintStrings(count)), `count=${count}`).toBe(true);
		}
	});

	it("uses single characters while they suffice", () => {
		const single = generateHintStrings(DEFAULT_HINT_CHARS.length);
		expect(single.every((h) => h.length === 1)).toBe(true);
	});

	it("escalates to two characters only once single chars run out", () => {
		const hints = generateHintStrings(DEFAULT_HINT_CHARS.length + 1);
		expect(hints.some((h) => h.length === 2)).toBe(true);
		expect(hints.every((h) => h.length <= 2)).toBe(true);
	});

	it("never emits an empty hint", () => {
		for (const count of [1, 2, 26]) {
			expect(generateHintStrings(count)).not.toContain("");
		}
	});

	it("throws when given fewer than two characters", () => {
		expect(() => generateHintStrings(5, "a")).toThrow();
	});
});

describe("codeToHintChar", () => {
	it("maps physical letter codes to their lowercase char, regardless of layout", () => {
		expect(codeToHintChar("KeyF")).toBe("f");
		expect(codeToHintChar("KeyA")).toBe("a");
		expect(codeToHintChar("KeyZ")).toBe("z");
	});

	it("returns null for non-letter codes", () => {
		expect(codeToHintChar("Digit1")).toBeNull();
		expect(codeToHintChar("Slash")).toBeNull();
		expect(codeToHintChar("Escape")).toBeNull();
		expect(codeToHintChar("")).toBeNull();
	});
});
