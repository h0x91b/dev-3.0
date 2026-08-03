// Proves the fast-path predicate over ALL of Unicode against bidi-js's own
// character tables, in both directions. Any drift between the hand-written range
// table and the library fails here rather than as a mystery rendering bug.
import { describe, expect, it } from "vitest";
import { codepointNeedsBidi, rowNeedsBidi } from "../detect";
import { defaultBidiEngine } from "../engine";
import { blank, row } from "./fixtures";

const engine = defaultBidiEngine();

/**
 * Bidi classes that can make visual order differ from logical order in an
 * LTR paragraph: the strong RTL ones, Arabic numbers, and every explicit
 * directional formatting character.
 */
const RELEVANT_CLASSES = new Set([
	"R",
	"AL",
	"AN",
	"RLE",
	"RLO",
	"RLI",
	"LRE",
	"LRO",
	"LRI",
	"FSI",
	"PDF",
	"PDI",
]);

describe("rtl detection conformance", () => {
	it("agrees with bidi-js for every codepoint in Unicode", () => {
		const falseNegatives: number[] = [];
		const falsePositives: number[] = [];

		for (let codepoint = 0; codepoint < 0x110000; codepoint++) {
			// Lone surrogates never reach us: cells carry whole codepoints.
			if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
			const relevant = RELEVANT_CLASSES.has(
				engine.getBidiCharTypeName(String.fromCodePoint(codepoint)),
			);
			const detected = codepointNeedsBidi(codepoint);
			if (relevant && !detected) falseNegatives.push(codepoint);
			if (detected && !relevant) falsePositives.push(codepoint);
		}

		expect(falseNegatives.map((c) => c.toString(16))).toEqual([]);
		expect(falsePositives.map((c) => c.toString(16))).toEqual([]);
	});

	it("detects the scripts and marks that actually matter", () => {
		for (const char of [
			"א", // Hebrew
			"ا", // Arabic
			"ܐ", // Syriac
			"ހ", // Thaana
			"ߊ", // NKo
			"ࠀ", // Samaritan
			"ࡀ", // Mandaic
			"٣", // Arabic-Indic digit
			"ﷲ", // Arabic presentation form
			"ﻻ", // Arabic presentation form B
			"‏", // RLM
			"‫", // RLE
			"‮", // RLO
			"⁧", // RLI
			"\u{10800}", // Cypriot (astral)
			"\u{1E900}", // Adlam (astral)
			"\u{1EE00}", // Arabic mathematical (astral)
		]) {
			expect(codepointNeedsBidi(char.codePointAt(0) ?? -1)).toBe(true);
		}
	});

	it("leaves every left-to-right script on the fast path", () => {
		for (const text of [
			"ls -la /tmp",
			"Привет мир",
			"日本語のテキスト",
			"한국어",
			"हिन्दी",
			"ไทย",
			"Ελληνικά",
			"Ĉu vi parolas?",
			"┌──┬──┐",
			"🎉👍🏽👨‍👩‍👧",
		]) {
			expect(rowNeedsBidi(row(text))).toBe(false);
		}
	});

	it("treats an empty and an all-blank row as nothing to do", () => {
		expect(rowNeedsBidi([])).toBe(false);
		expect(rowNeedsBidi(Array.from({ length: 80 }, blank))).toBe(false);
	});

	it("flags a row where an explicit override reverses pure ASCII", () => {
		expect(rowNeedsBidi(row("‮abcdef"))).toBe(true);
	});
});
