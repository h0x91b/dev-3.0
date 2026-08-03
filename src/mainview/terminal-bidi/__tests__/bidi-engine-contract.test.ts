// Pins the bidi-js behaviours the reorder layer is built on. A single-run
// reversal is its own inverse, so a backwards index map still "looks fixed" on
// pure Hebrew — this file is what catches that, and it fails loudly if a
// bidi-js upgrade changes the contract.
import bidiFactory from "bidi-js";
import { describe, expect, it } from "vitest";

// The full library, not the narrowed seam — this file is about bidi-js itself.
const engine = bidiFactory();

function levelsOf(text: string) {
	return engine.getEmbeddingLevels(text, "ltr");
}

describe("bidi-js contract", () => {
	it("getReorderedIndices maps visual position to logical position", () => {
		const text = "abc שלום def";
		const indices = engine.getReorderedIndices(text, levelsOf(text));

		// Latin stays put; the Hebrew run is the only thing that moves.
		expect(indices.slice(0, 4)).toEqual([0, 1, 2, 3]);
		expect(indices.slice(4, 8)).toEqual([7, 6, 5, 4]);
		expect(indices.slice(8)).toEqual([8, 9, 10, 11]);

		// The direction of the map: indices[visual] indexes into the logical text.
		expect(indices.map((logical) => text[logical]).join("")).toBe("abc םולש def");
	});

	it("forces base direction LTR so a pure Hebrew line stays left-aligned", () => {
		const text = "שלום     ";
		const levels = levelsOf(text);
		expect(levels.paragraphs[0].level).toBe(0);
		expect(engine.getReorderedString(text, levels)).toBe("םולש     ");
	});

	it("keeps weak-LTR digits in logical order inside an RTL run", () => {
		const persian = "سلام ۱۲۳";
		expect(engine.getReorderedString(persian, levelsOf(persian))).toContain("۱۲۳");

		const arabic = "٣٤٥ عربي";
		expect(engine.getReorderedString(arabic, levelsOf(arabic))).toContain("٣٤٥");
	});

	it("reports no reorder segments for text with nothing to reorder", () => {
		for (const text of ["ls -la /tmp", "Привет мир", "日本語", "א"]) {
			expect(engine.getReorderSegments(text, levelsOf(text))).toEqual([]);
		}
	});

	it("mirrors brackets only when they resolve to an odd level", () => {
		const inside = "א(ב)ג";
		expect([...engine.getMirroredCharactersMap(inside, levelsOf(inside).levels)]).toEqual([
			[1, ")"],
			[3, "("],
		]);

		// Brackets around an RTL run stay at level 0 and must NOT be mirrored.
		const around = "(שלום)";
		expect(engine.getMirroredCharactersMap(around, levelsOf(around).levels).size).toBe(0);
	});

	it("reads astral characters as neutral surrogate halves", () => {
		// The limitation that forces the BMP stand-in probe in reorder.ts: bidi-js
		// walks UTF-16 units, so astral RTL (here Adlam) resolves to level 0.
		const adlam = "\u{1E900}\u{1E901}";
		expect(Array.from(levelsOf(adlam).levels)).toEqual([0, 0, 0, 0]);
		// Its character table does know the type, which is what we exploit.
		expect(engine.getBidiCharTypeName("\u{1E900}")).toBe("R");
	});
});
