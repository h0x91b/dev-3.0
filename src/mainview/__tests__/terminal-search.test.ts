import { buildSearchLine, findMatches, type SearchLine } from "../terminal-search";

type FakeCell = { c: string; w?: number };

/** A fake buffer line: `c: ""` is an empty cell, `w: 0` a wide-char spacer tail. */
function line(cells: FakeCell[]) {
	return {
		length: cells.length,
		getCell: (x: number) => ({ getChars: () => cells[x].c, getWidth: () => cells[x].w ?? 1 }),
	};
}

const plain = (text: string): SearchLine => buildSearchLine(line([...text].map((c) => ({ c }))));

describe("findMatches", () => {
	it("returns every match on a line and across lines, in buffer order", () => {
		expect(findMatches(["ab ab", "none", "xab"].map(plain), "ab")).toEqual([
			{ row: 0, col: 0, length: 2 },
			{ row: 0, col: 3, length: 2 },
			{ row: 2, col: 1, length: 2 },
		]);
	});

	it("ignores case", () => {
		expect(findMatches([plain("Hello HELLO")], "hello")).toHaveLength(2);
		expect(findMatches([plain("hello")], "HeLLo")).toHaveLength(1);
	});

	it("does not count overlapping matches twice", () => {
		expect(findMatches([plain("aaaa")], "aa")).toEqual([
			{ row: 0, col: 0, length: 2 },
			{ row: 0, col: 2, length: 2 },
		]);
	});

	it("returns nothing for an empty query or no match", () => {
		expect(findMatches([plain("abc")], "")).toEqual([]);
		expect(findMatches([plain("abc")], "z")).toEqual([]);
		expect(findMatches([], "a")).toEqual([]);
	});

	it("does not match across a tab gap of empty cells", () => {
		const tab = line([{ c: "a" }, { c: "" }, { c: "" }, { c: "b" }]);
		expect(findMatches([buildSearchLine(tab)], "ab")).toEqual([]);
		expect(findMatches([buildSearchLine(tab)], "a  b")).toEqual([{ row: 0, col: 0, length: 4 }]);
	});

	it("keeps columns right after a wide character and skips its spacer cell", () => {
		const wide = line([{ c: "中", w: 2 }, { c: "", w: 0 }, { c: "x" }, { c: "y" }]);
		expect(findMatches([buildSearchLine(wide)], "xy")).toEqual([{ row: 0, col: 2, length: 2 }]);
		expect(findMatches([buildSearchLine(wide)], "中")).toEqual([{ row: 0, col: 0, length: 2 }]);
	});

	it("counts a match that contains an emoji in cells, not UTF-16 units", () => {
		const emoji = line([{ c: "a" }, { c: "😀", w: 2 }, { c: "", w: 0 }, { c: "b" }]);
		expect(findMatches([buildSearchLine(emoji)], "a😀b")).toEqual([{ row: 0, col: 0, length: 4 }]);
	});

	it("keeps indices when lowercasing changes a character's length", () => {
		const dotted = line([{ c: "İ" }, { c: "x" }]);
		expect(findMatches([buildSearchLine(dotted)], "x")).toEqual([{ row: 0, col: 1, length: 1 }]);
	});

	it("a visible query always matches itself (İ, final sigma)", () => {
		expect(findMatches([plain("xİy")], "İ")).toEqual([{ row: 0, col: 1, length: 1 }]);
		expect(findMatches([plain("ΟΣ")], "ΟΣ")).toEqual([{ row: 0, col: 0, length: 2 }]);
		expect(findMatches([plain("ΟΣ")], "ος")).toEqual([{ row: 0, col: 0, length: 2 }]);
		expect(findMatches([plain("ος")], "ΟΣ")).toEqual([{ row: 0, col: 0, length: 2 }]);
	});
});
