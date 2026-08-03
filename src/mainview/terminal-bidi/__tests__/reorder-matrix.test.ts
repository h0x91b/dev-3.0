// The language matrix. Every case pins the exact painted result AND runs the
// structural invariants, so a change that "fixes" Hebrew by corrupting cells,
// widths, colours or the index maps fails here.
import { describe, expect, it } from "vitest";
import { reorderRow } from "../reorder";
import {
	assertRowInvariants,
	blank,
	cell,
	columnText,
	graphemeCell,
	paintedText,
	row,
} from "./fixtures";

/** [case name, logical text, expected painted text] */
const MATRIX: [name: string, logical: string, visual: string][] = [
	["pure hebrew", "שלום", "םולש"],
	["hebrew keeps its left margin", "שלום     ", "םולש     "],
	["leading indentation survives", "    שלום", "    םולש"],
	["pure arabic, order only", "سلام", "مالس"],
	["persian extended digits stay in logical order", "سلام ۱۲۳", "۱۲۳ مالس"],
	["arabic-indic digits stay in logical order", "٣٤٥ عربي", "يبرع ٣٤٥"],
	["latin around hebrew is asymmetric", "abc שלום def", "abc םולש def"],
	["two hebrew runs around latin", "אב cd הו", "בא cd וה"],
	["a filename inside hebrew stays readable", "קובץ config.txt נמצא", "ץבוק config.txt אצמנ"],
	["hebrew filename with extension", "open שלום.txt", "open םולש.txt"],
	["trailing period stays right of the run", "שלום.", "םולש."],
	["brackets around a run are not mirrored", "(שלום)", "(םולש)"],
	["brackets inside a run are mirrored", "א(ב)ג", "ג(ב)א"],
	["wide characters beside hebrew", "日本 שלום", "日本 םולש"],
	["wide characters between hebrew words", "אב 日本 גד", "בא 日本 דג"],
	["an override reverses pure ascii", "‮abcdef", "‮fedcba"],
	["an embedding keeps its content left-to-right", "a‫bc‬d", "a‫bc‬d"],
	["an isolate keeps its content left-to-right", "⁧abc⁩", "⁧abc⁩"],
	["emoji on both sides of hebrew", "🎉 שלום 🎉", "🎉 םולש 🎉"],
	["astral right-to-left script", "\u{1E900}\u{1E901}", "\u{1E901}\u{1E900}"],
	// Two right-to-left scripts with only a space between them are ONE run — the
	// space inherits the surrounding direction — so the whole span reverses.
	["hebrew after syriac reverses as one run", "ܐܒ אב", "בא ܒܐ"],
	["thaana", "ހށ", "ށހ"],
];

describe("reorderRow language matrix", () => {
	it.each(MATRIX)("%s", (_name, logical, visual) => {
		const input = row(logical);
		const result = reorderRow(input);
		if (result === null) throw new Error("expected this row to be reordered");
		expect(paintedText(result.cells)).toBe(visual);
		assertRowInvariants(input, result);
	});
});

describe("reorderRow cell-level edge cases", () => {
	it("keeps a wide cell in front of its spacer", () => {
		const input = [
			cell("א"),
			cell("ב"),
			blank(),
			cell("日", { width: 2 }),
			cell("", { codepoint: 0, width: 0 }),
		];
		const result = reorderRow(input);
		if (!result) throw new Error("expected a reorder");
		assertRowInvariants(input, result);

		const wide = result.cells.findIndex((item) => item.width === 2);
		expect(wide).toBeGreaterThanOrEqual(0);
		expect(result.cells[wide + 1].width).toBe(0);
		expect(columnText(result.cells)).toBe("בא 日␀");
	});

	it("keeps a combining cell attached to its base", () => {
		const combining = cell("́", { width: 0 });
		const input = [cell("a"), combining, cell("א"), cell("ב")];
		const result = reorderRow(input);
		if (!result) throw new Error("expected a reorder");
		assertRowInvariants(input, result);

		const base = result.cells.indexOf(input[0]);
		expect(result.cells[base + 1]).toBe(combining);
	});

	it("survives a zero-width cell with no owner at column 0", () => {
		const input = [cell("́", { width: 0 }), cell("א"), cell("ב")];
		const result = reorderRow(input);
		if (!result) throw new Error("expected a reorder");
		assertRowInvariants(input, result);
		expect(result.cells[0]).toBe(input[0]);
	});

	it("reverses a niqqud grapheme row without touching its cluster text", () => {
		const input = [graphemeCell("שָׁ"), graphemeCell("לוֹ"), graphemeCell("ם")];
		const result = reorderRow(input);
		if (!result) throw new Error("expected a reorder");
		assertRowInvariants(input, result);
		// "שָׁ" and "לוֹ" are three codepoints each, "ם" is one.
		expect(result.cells.map((item) => item.grapheme_len)).toEqual([1, 3, 3]);
		expect(Array.from(result.visualToLogical)).toEqual([2, 1, 0]);
	});

	it("never mirrors a grapheme cell", () => {
		const bracket = graphemeCell("(́");
		const input = [cell("א"), bracket, cell("ב")];
		const result = reorderRow(input);
		if (!result) throw new Error("expected a reorder");
		expect(result.cells).toContain(bracket);
	});

	it("carries hyperlink ids and attributes with their own cell", () => {
		const input = [
			cell("א", { hyperlink_id: 7, flags: 16 }),
			cell("ב", { hyperlink_id: 7 }),
			blank(),
			cell("a", { fg_r: 1, fg_g: 2, fg_b: 3 }),
		];
		const result = reorderRow(input);
		if (!result) throw new Error("expected a reorder");
		assertRowInvariants(input, result);
		expect(result.cells[0]).toBe(input[1]);
		expect(result.cells[1]).toBe(input[0]);
		expect(result.cells[1].flags).toBe(16);
		expect(result.cells[3]).toBe(input[3]);
	});

	it("preserves the length of a row shorter than the screen", () => {
		const input = row("שלום");
		const result = reorderRow(input);
		expect(result?.cells).toHaveLength(4);
	});
});

describe("cursor column mapping", () => {
	const hebrew = row("שלום  ");
	const mapped = reorderRow(hebrew);

	it("maps the first logical cell to the last column of its run", () => {
		expect(mapped?.logicalToVisual[0]).toBe(3);
	});

	it("maps inside the run", () => {
		expect(Array.from(mapped?.logicalToVisual ?? [])).toEqual([3, 2, 1, 0, 4, 5]);
	});

	it("leaves trailing blank columns where they are", () => {
		expect(mapped?.logicalToVisual[4]).toBe(4);
		expect(mapped?.logicalToVisual[5]).toBe(5);
	});

	it("is the exact inverse of the visual mapping", () => {
		const { logicalToVisual, visualToLogical } = mapped ?? {
			logicalToVisual: new Int32Array(),
			visualToLogical: new Int32Array(),
		};
		for (let i = 0; i < logicalToVisual.length; i++) {
			expect(visualToLogical[logicalToVisual[i]]).toBe(i);
		}
	});

	it("maps a mixed row's latin columns to themselves", () => {
		const result = reorderRow(row("abc שלום def"));
		if (!result) throw new Error("expected a reorder");
		for (const column of [0, 1, 2, 3, 8, 9, 10, 11]) {
			expect(result.logicalToVisual[column]).toBe(column);
		}
	});
});
