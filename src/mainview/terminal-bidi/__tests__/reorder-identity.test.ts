// The "nothing else broke" half of the suite: every row without right-to-left
// content must come back as `null`, meaning the renderer keeps the vendor's own
// array and paints byte-for-byte what it painted before the feature existed.
import { describe, expect, it } from "vitest";
import { reorderRow } from "../reorder";
import { blank, cell, graphemeCell, padded, row } from "./fixtures";

const LTR_CORPUS: [name: string, text: string][] = [
	["ascii shell command", "ls -la /tmp && echo done"],
	["ascii with punctuation and digits", "cat file.txt | grep -n 'foo' # 42%"],
	["russian", "Привет мир, как дела?"],
	["greek", "Ελληνικά κείμενο"],
	["japanese", "日本語のテキストです"],
	["korean", "한국어 텍스트"],
	["chinese mixed with ascii", "文件 config.txt 已保存"],
	["devanagari with left-extending vowel signs", "हिन्दी में लिखा"],
	["thai", "ข้อความภาษาไทย"],
	["emoji", "🎉 done 🚀"],
	["emoji with zwj family", "👨‍👩‍👧 family"],
	["emoji with skin tone modifier", "👍🏽 ok"],
	["box drawing", "┌────────┬────────┐"],
	["tui table row", "│ name    │     42 │"],
	["powerline prompt", "  ~/src/dev-3.0   main ± "],
	["ansi art blocks", "▀▄█▓▒░ ░▒▓█▄▀"],
	["accented latin", "Ĉu vi parolas Esperanton? Où ça? Größe"],
];

describe("reorderRow leaves left-to-right rows untouched", () => {
	it.each(LTR_CORPUS)("%s", (_name, text) => {
		expect(reorderRow(row(text))).toBeNull();
	});

	it.each(LTR_CORPUS)("%s, padded to 80 columns", (_name, text) => {
		expect(reorderRow(padded(row(text), 80))).toBeNull();
	});

	it("an empty row", () => {
		expect(reorderRow([])).toBeNull();
	});

	it("a row of nothing but blank cells", () => {
		expect(reorderRow(Array.from({ length: 80 }, blank))).toBeNull();
	});

	it("a grapheme cell that is not right-to-left", () => {
		expect(reorderRow([graphemeCell("👨‍👩‍👧", 2), cell("", { width: 0 })])).toBeNull();
	});

	it("a wide cell and its zero-width spacer", () => {
		expect(reorderRow([cell("日", { width: 2 }), cell("", { codepoint: 0, width: 0 })])).toBeNull();
	});

	it("a left-to-right mark, which changes nothing on its own", () => {
		expect(reorderRow(row("abc‎def"))).toBeNull();
	});

	it("a right-to-left mark between two latin words, which reorders nothing", () => {
		expect(reorderRow(row("abc‏def"))).toBeNull();
	});
});
