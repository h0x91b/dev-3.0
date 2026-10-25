import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { Ghostty } from "ghostty-web";

const { values } = parseArgs({ options: { case: { type: "string" }, wasm: { type: "string" } } });
const ESC = "\x1b";
const started = performance.now();
const limits = { inputBytes: 4 * 1024 * 1024, writes: 4000, resizes: 100 };
const counts = { inputBytes: 0, writes: 0, resizes: 0, warnings: 0 };
let phase = "load";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
console.log = console.warn = console.error = () => { counts.warnings++; };

// Default loading must exercise the embedded dependency binary, as init() does.
// The low-level core needs only this browser global; no DOM or server is created.
globalThis.self = { location: import.meta.url };
let wasmSource;
if (values.wasm) {
	assert.ok(statSync(values.wasm).size <= 64 * 1024 * 1024, "WASM file budget");
	wasmSource = "data:application/wasm;base64," + readFileSync(values.wasm).toString("base64");
}

const load = () => Ghostty.load(wasmSource);
const create = (core, cols, rows, scrollbackLimit = 10000) => core.createTerminal(cols, rows, {
	scrollbackLimit, fgColor: 0xc0c0c0, bgColor: 0x151515, cursorColor: 0xffffff,
});
function write(term, text) {
	phase = "write";
	counts.inputBytes += Buffer.byteLength(text);
	assert.ok(counts.inputBytes <= limits.inputBytes, "synthetic input budget");
	assert.ok(++counts.writes <= limits.writes, "write budget");
	term.write(text);
}
function resize(term, cols, rows) {
	phase = "resize";
	assert.ok(++counts.resizes <= limits.resizes, "resize budget");
	emit({ type: "progress", case: values.case, phase, cols, rows, writes: counts.writes });
	term.resize(cols, rows);
	assert.deepEqual(term.getDimensions(), { cols, rows });
}
function draw(term) {
	phase = "update"; term.update();
	phase = "viewport"; term.getViewport();
	phase = "mark-clean"; term.markClean();
}
function textOf(cells, grapheme) {
	return cells.map((cell, col) => cell.width === 0 ? "" : cell.codepoint === 0 ? " "
		: cell.grapheme_len > 0 ? grapheme(col) : String.fromCodePoint(cell.codepoint)).join("").trimEnd();
}
function rowText(term, row, history = false) {
	const cells = history ? term.getScrollbackLine(row) : term.getLine(row);
	assert.ok(cells, "row exists");
	return textOf(cells, (col) => history ? term.getScrollbackGraphemeString(row, col) : term.getGraphemeString(row, col));
}
function screen(term, expected) {
	phase = "screen";
	const { cols, rows } = term.getDimensions();
	term.update();
	const viewport = term.getViewport();
	assert.ok(viewport.length >= cols * rows, "viewport contains the active grid");
	for (let row = 0; row < rows; row++) {
		const text = textOf(viewport.slice(row * cols, (row + 1) * cols), (col) => term.getGraphemeString(row, col));
		assert.equal(text, expected[row] || "", `viewport row ${row}`);
		assert.equal(rowText(term, row), expected[row] || "", `line row ${row}`);
	}
}
function cursor(term, x, y) {
	const actual = term.getCursor();
	assert.deepEqual({ x: actual.x, y: actual.y }, { x, y });
}
function free(term) { phase = "free"; term.free(); }

async function semantics() {
	const term = create(await load(), 12, 4);
	screen(term, []); cursor(term, 0, 0);
	write(term, "a\u0301b\u0323界X");
	screen(term, ["a\u0301b\u0323界X"]); cursor(term, 5, 0);
	assert.equal(term.getLine(0)[2].width, 2);
	write(term, ESC + "[HZ");
	screen(term, ["Zb\u0323界X"]);
	assert.equal(term.getGraphemeString(0, 0), "Z");
	write(term, "\r" + ESC + "[2K" + "a\u0301".repeat(10) + ESC + "[H");
	resize(term, 6, 4); screen(term, ["a\u0301".repeat(6), "a\u0301".repeat(4)]); cursor(term, 0, 0);
	resize(term, 12, 4); screen(term, ["a\u0301".repeat(10)]); cursor(term, 0, 0);
	write(term, ESC + "[2;5HXY" + ESC + "[38;2;12;34;56mZ" + ESC + "[0m");
	screen(term, ["a\u0301".repeat(10), "    XYZ"]); cursor(term, 7, 1);
	const cell = term.getLine(1)[6];
	assert.deepEqual([cell.fg_r, cell.fg_g, cell.fg_b], [12, 34, 56]);
	write(term, ESC + "[6n"); assert.equal(term.readResponse(), ESC + "[2;8R");
	write(term, ESC + "[?2004h" + ESC + "[?1004h" + ESC + "[?1000h" + ESC + "[?25l");
	assert.deepEqual([term.hasBracketedPaste(), term.hasFocusEvents(), term.hasMouseTracking()], [true, true, true]);
	write(term, ESC + "c");
	screen(term, []); cursor(term, 0, 0);
	assert.equal(term.getScrollbackLength(), 0);
	assert.deepEqual([term.hasBracketedPaste(), term.hasFocusEvents(), term.hasMouseTracking()], [false, false, false]);
	assert.equal(Boolean(term.getCursor().visible), true); free(term);

	const alternate = create(await load(), 10, 3);
	write(alternate, "one\r\ntwo\r\nthree\r\nfour");
	screen(alternate, ["two", "three", "four"]); cursor(alternate, 4, 2);
	assert.equal(alternate.getScrollbackLength(), 1);
	assert.equal(rowText(alternate, 0, true), "one");
	write(alternate, ESC + "[?1049h" + ESC + "[HALT");
	assert.equal(alternate.isAlternateScreen(), true); screen(alternate, ["ALT"]);
	resize(alternate, 12, 3); screen(alternate, ["ALT"]);
	resize(alternate, 10, 3); screen(alternate, ["ALT"]);
	write(alternate, ESC + "[?1049l");
	assert.equal(alternate.isAlternateScreen(), false);
	screen(alternate, ["two", "three", "four"]); cursor(alternate, 4, 2);
	assert.equal(alternate.getScrollbackLength(), 1);
	assert.equal(rowText(alternate, 0, true), "one");
	write(alternate, ESC + "c");
	screen(alternate, []); cursor(alternate, 0, 0);
	assert.equal(alternate.getScrollbackLength(), 0); free(alternate);
}

async function lifetime(reflow, originalWidth = false) {
	const core = await load();
	const line = "a\u0301".repeat(40);
	for (let cycle = 0; cycle < 2; cycle++) {
		phase = "create"; emit({ type: "progress", case: values.case, phase, cycle });
		const term = create(core, 80, 24);
		draw(term); write(term, ESC + "c");
		let cols = 80;
		for (let n = 0; n < 240; n++) {
			write(term, line + "\r\n");
			if (n % 12 === 0) draw(term);
			if (reflow && [60, 120, 180].includes(n)) {
				cols = n === 120 ? 160 : originalWidth ? 40 : 42;
				resize(term, cols, 24); draw(term);
			}
		}
		// Exactly filling column 40 has a separate existing combining-mark bug.
		// This case tests the original trap; the 42-column case checks correct text.
		if (!originalWidth) {
			screen(term, [...Array(23).fill(line), ""]); cursor(term, 0, 23);
			assert.equal(term.getScrollbackLength(), 217);
			assert.equal(rowText(term, 0, true), line);
			assert.equal(rowText(term, 216, true), line);
		}
		write(term, ESC + "[H" + "b\u0323".repeat(40)); draw(term);
		if (!originalWidth) {
			screen(term, ["b\u0323".repeat(40), ...Array(22).fill(line), ""]);
			cursor(term, 40, 0);
		}
		assert.deepEqual(term.getDimensions(), { cols, rows: 24 }); free(term);
	}
}

function scrollPayload(rep) {
	const lines = [];
	let index = 0;
	const marked = (wire, plain) => {
		const marker = `R${String(rep).padStart(2, "0")}L${String(index++).padStart(3, "0")}`;
		lines.push({ wire: ESC + "[38;5;34m" + marker + ESC + "[0m " + wire, plain: marker + " " + plain });
	};
	const blank = () => { lines.push({ wire: "", plain: "" }); index++; };
	marked(ESC + "[1m" + "═".repeat(72) + ESC + "[0m", "═".repeat(72));
	marked(ESC + "[1mScroll growth regression" + ESC + "[0m", "Scroll growth regression"); blank();
	for (let row = 0; row < 8; row++) {
		let wire = "";
		for (let col = 0; col < 32; col++) wire += `${ESC}[48;5;${row * 32 + col}m  ${ESC}[0m`;
		marked(wire, " ".repeat(64));
	}
	blank();
	for (let row = 0; row < 8; row++) {
		let wire = "";
		for (let col = 0; col < 80; col++) wire += `${ESC}[48;2;${(col * 7 + row) % 256};80;160m ${ESC}[0m`;
		marked(wire, " ".repeat(80));
	}
	blank();
	marked(ESC + "[1mBold" + ESC + "[0m " + ESC + "[3mItalic" + ESC + "[0m", "Bold Italic");
	marked("wrap ".repeat(48), "wrap ".repeat(48)); blank();
	for (let section = 0; section < 8; section++) {
		marked(ESC + "[1mGrid " + section + ESC + "[0m", "Grid " + section);
		for (let row = 0; row < 8; row++) {
			let wire = "";
			for (let col = 0; col < 70; col++) {
				const color = (section * 64 + row * 8 + col) % 256;
				wire += (col + row) % 3 === 0 ? `${ESC}[38;2;${color};70;90m*${ESC}[0m` : `${ESC}[38;5;${color}m*${ESC}[0m`;
			}
			marked(wire, "*".repeat(70));
		}
		blank();
	}
	marked(ESC + "[32mDONE" + ESC + "[0m", "DONE"); blank();
	return {
		wire: lines.map((line) => line.wire).join("\r\n") + "\r\n",
		lastRows: [...lines.slice(-38).map((line) => line.plain.trimEnd()), ""],
	};
}

async function scrollGrowth() {
	const term = create(await load(), 160, 39, 10_000_000);
	for (let rep = 0; rep < 6; rep++) {
		const { wire, lastRows } = scrollPayload(rep);
		write(term, wire); screen(term, lastRows); cursor(term, 0, 38);
		for (let row = 0; row < 39; row++) assert.equal(term.isRowWrapped(row), false);
		term.markClean();
	}
	free(term);
}

async function styleReflow() {
	const term = create(await load(), 80, 24);
	resize(term, 267, 68);
	const body = "lorem ipsum dolor sit amet ".repeat(6);
	const plain = Array.from({ length: 240 }, (_, i) => `${String(i).padStart(6)} ${"-".repeat(20)} ${body}`);
	const wire = plain.map((line, i) => `${ESC}[38;5;${i % 120}m${line.slice(0, 6)}${ESC}[0m${line.slice(6)}\r\n`).join("");
	for (let offset = 0; offset < wire.length; offset += 4096) write(term, wire.slice(offset, offset + 4096));
	for (const [cols, rows] of [[238, 60], [120, 40], [267, 68]]) {
		resize(term, cols, rows);
		const physical = plain.flatMap((line) => {
			const parts = [];
			for (let start = 0; start < line.length; start += cols) parts.push(line.slice(start, start + cols).trimEnd());
			return parts;
		});
		physical.push(""); screen(term, physical.slice(-rows)); cursor(term, 0, rows - 1);
	}
	free(term);
}

const cases = {
	semantics,
	"grapheme-reuse": () => lifetime(false),
	"grapheme-reflow": () => lifetime(true),
	"original-width-reflow": () => lifetime(true, true),
	"scroll-growth": scrollGrowth,
	"style-reflow": styleReflow,
};

try {
	assert.ok(Object.hasOwn(cases, values.case), "known bounded fixture required");
	await cases[values.case]();
	emit({ type: "result", case: values.case, status: "pass", counts, ms: performance.now() - started });
} catch (error) {
	const status = error instanceof WebAssembly.RuntimeError ? "trap" : error?.code === "ERR_ASSERTION" ? "assertion" : "error";
	emit({ type: "result", case: values.case, status, phase, counts, error: String(error?.message || error).slice(0, 600), ms: performance.now() - started });
	// A trapped core may have invalid allocator state; process exit owns cleanup.
	process.exitCode = 1;
}
