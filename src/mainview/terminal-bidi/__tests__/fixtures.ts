// Shared builders for the terminal-bidi suites. Not a `.test.ts` file on purpose.
import type { GhosttyCell } from "ghostty-web";
import type { ReorderedRow } from "../reorder";

export function cell(
	text: string,
	overrides: Partial<GhosttyCell> = {},
): GhosttyCell {
	return {
		codepoint: text === "" ? 0 : (text.codePointAt(0) ?? 0),
		fg_r: 200,
		fg_g: 200,
		fg_b: 200,
		bg_r: 0,
		bg_g: 0,
		bg_b: 0,
		flags: 0,
		width: 1,
		hyperlink_id: 0,
		grapheme_len: 0,
		...overrides,
	};
}

/** A blank column as ghostty reports it: codepoint 0, not a space. */
export function blank(): GhosttyCell {
	return cell("", { codepoint: 0 });
}

/** A cell whose text is a multi-codepoint grapheme cluster (niqqud, ZWJ emoji). */
export function graphemeCell(cluster: string, width = 1): GhosttyCell {
	return cell(cluster, { grapheme_len: [...cluster].length, width });
}

const WIDE_RANGES: readonly [number, number][] = [
	[0x1100, 0x115f],
	[0x2e80, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff],
];

function isWide(codepoint: number): boolean {
	return WIDE_RANGES.some(([lo, hi]) => codepoint >= lo && codepoint <= hi);
}

/**
 * Build a row from a plain string: one cell per codepoint, wide codepoints
 * expanded to a `width: 2` cell plus its `width: 0` spacer, exactly the way
 * ghostty lays them out.
 */
export function row(text: string): GhosttyCell[] {
	const cells: GhosttyCell[] = [];
	for (const char of text) {
		const codepoint = char.codePointAt(0) ?? 0;
		if (char === " ") {
			cells.push(blank());
			continue;
		}
		if (isWide(codepoint)) {
			cells.push(cell(char, { width: 2 }));
			cells.push(cell("", { codepoint: 0, width: 0 }));
			continue;
		}
		cells.push(cell(char));
	}
	return cells;
}

/** Pad a row to `cols` with blanks, the way a real terminal row arrives. */
export function padded(cells: GhosttyCell[], cols: number): GhosttyCell[] {
	const out = cells.slice();
	while (out.length < cols) out.push(blank());
	return out;
}

/**
 * The visible text of a row, one character per painted column — the string a
 * reader actually sees. Skips `width: 0` cells, exactly as `renderLine` does.
 */
export function paintedText(cells: readonly GhosttyCell[]): string {
	let out = "";
	for (const item of cells) {
		if (item.width === 0) continue;
		out += String.fromCodePoint(item.codepoint || 0x20);
	}
	return out;
}

/** Same, but every column contributes a character so columns stay comparable. */
export function columnText(cells: readonly GhosttyCell[]): string {
	return cells
		.map((item) => (item.width === 0 ? "␀" : String.fromCodePoint(item.codepoint || 0x20)))
		.join("");
}

/**
 * Structural guarantees every reorder must satisfy, whatever the language.
 * Run on every matrix case — this is what makes the suite exhaustive rather
 * than anecdotal.
 */
export function assertRowInvariants(
	input: readonly GhosttyCell[],
	result: ReorderedRow,
): void {
	const { cells: output, visualToLogical, logicalToVisual } = result;
	const n = input.length;

	expect(output).toHaveLength(n);
	expect(visualToLogical).toHaveLength(n);
	expect(logicalToVisual).toHaveLength(n);

	// Cells are permuted references, never rebuilt. Mirrored cells are the one
	// allowed clone, and they must be structurally identical bar the codepoint.
	const originals = new Set<GhosttyCell>(input);
	let clones = 0;
	for (let visual = 0; visual < n; visual++) {
		const item = output[visual];
		const source = input[visualToLogical[visual]];
		if (item === source) continue;
		clones++;
		expect(originals.has(item)).toBe(false);
		expect({ ...item, codepoint: 0 }).toEqual({ ...source, codepoint: 0 });
	}
	expect(clones).toBeLessThanOrEqual(n);

	// Index maps are exact inverses and a true permutation.
	const seen = new Set<number>();
	for (let visual = 0; visual < n; visual++) {
		const logical = visualToLogical[visual];
		expect(logical).toBeGreaterThanOrEqual(0);
		expect(logical).toBeLessThan(n);
		expect(seen.has(logical)).toBe(false);
		seen.add(logical);
		expect(logicalToVisual[logical]).toBe(visual);
	}

	// Total painted width is preserved, so the row still fills the same columns.
	const width = (cells: readonly GhosttyCell[]) =>
		cells.reduce((sum, item) => sum + item.width, 0);
	expect(width(output)).toBe(width(input));

	// A zero-width cell still trails the same owner it trailed before.
	for (let visual = 1; visual < n; visual++) {
		if (output[visual].width !== 0) continue;
		expect(visualToLogical[visual]).toBe(visualToLogical[visual - 1] + 1);
	}

	// Attributes travel with their cell: no colour, flag or link smear.
	const signature = (cells: readonly GhosttyCell[]) =>
		cells
			.map(
				(item) =>
					`${item.fg_r},${item.fg_g},${item.fg_b},${item.bg_r},${item.bg_g},${item.bg_b},${item.flags},${item.hyperlink_id},${item.grapheme_len},${item.width}`,
			)
			.sort()
			.join("|");
	expect(signature(output)).toBe(signature(input));
}

/** Deterministic pseudo-randomness — `Math.random` is unavailable in this harness. */
export function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

export interface RecordedOp {
	op: string;
	args: number[] | string[];
	fillStyle: string;
	font: string;
}

/**
 * A 2D-context stub covering exactly the calls `CanvasRenderer` makes. happy-dom
 * returns null from `getContext`, and `measureFont()` creates its own canvas, so
 * callers must spy on `HTMLCanvasElement.prototype.getContext`.
 */
export function recordingCtx(): {
	ctx: Record<string, unknown>;
	ops: RecordedOp[];
} {
	const ops: RecordedOp[] = [];
	const ctx: Record<string, unknown> = {
		font: "",
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		globalAlpha: 1,
		textBaseline: "alphabetic",
		textAlign: "left",
		// A fractional advance under a whole-pixel cell, and a line box taller than
		// the ink of an "M": both halves of the gap the glyph-cell fit closes.
		measureText: () => ({
			width: 9.5,
			actualBoundingBoxAscent: 12,
			actualBoundingBoxDescent: 3,
			fontBoundingBoxAscent: 14,
			fontBoundingBoxDescent: 4,
		}),
		// The renderer scales by its devicePixelRatio once; the suites build it at 1.
		getTransform: () => ({ a: 1, d: 1 }),
		beginPath: () => {},
		moveTo: () => {},
		lineTo: () => {},
		stroke: () => {},
	};
	function record(op: string) {
		return (...args: (number | string)[]) => {
			ops.push({
				op,
				args: args as number[] | string[],
				fillStyle: String(ctx.fillStyle),
				font: String(ctx.font),
			});
		};
	}
	ctx.fillRect = record("fillRect");
	ctx.fillText = record("fillText");
	// Recorded, not stubbed away: the glyph-cell fit's whole behaviour is the
	// clip + transform it wraps a glyph in.
	ctx.save = record("save");
	ctx.restore = record("restore");
	ctx.translate = record("translate");
	ctx.scale = record("scale");
	ctx.rect = record("rect");
	ctx.clip = record("clip");
	ctx.clearRect = record("clearRect");
	// The glyph atlas blits from a strip canvas. The image argument is dropped from
	// the record: it is a live canvas node, and only the geometry is assertable.
	ctx.drawImage = (_image: unknown, ...rest: number[]) => {
		ops.push({ op: "drawImage", args: rest, fillStyle: String(ctx.fillStyle), font: String(ctx.font) });
	};
	return { ctx, ops };
}

/** A minimal `IRenderable` over a fixed grid of rows. */
export function fakeRenderable(
	rows: GhosttyCell[][],
	cols: number,
	cursor = { x: 0, y: 0, visible: false },
) {
	return {
		getLine: (y: number) => (rows[y] ? rows[y].map((item) => ({ ...item })) : null),
		getCursor: () => ({ ...cursor }),
		getDimensions: () => ({ cols, rows: rows.length }),
		isRowDirty: () => true,
		needsFullRedraw: () => false,
		clearDirty: () => {},
		getGraphemeString: (rowIndex: number, col: number) => {
			const item = rows[rowIndex]?.[col];
			return item ? String.fromCodePoint(item.codepoint || 0x20) : "";
		},
	};
}
