import type { GhosttyCell } from "ghostty-web";
import { rowNeedsBidi } from "./detect";
import { type BidiEngine, defaultBidiEngine } from "./engine";

export interface ReorderedRow {
	/** The row's cells in visual (paint) order. Index = screen column. */
	cells: GhosttyCell[];
	/** visualToLogical[screenColumn] = original cell index. */
	visualToLogical: Int32Array;
	/** logicalToVisual[cellIndex] = screen column. */
	logicalToVisual: Int32Array;
}

/** An empty terminal cell carries codepoint 0, which is Bidi_Class BN and would
 *  be dropped from reordering — every blank column must probe as a space. */
const BLANK = 0x20;

/**
 * One BMP stand-in per Bidi_Class. Astral cells probe as their stand-in so that
 * every cluster occupies exactly one UTF-16 unit, which makes bidi-js's indices
 * equal cluster indices by construction (and incidentally fixes astral RTL,
 * which bidi-js itself misreads as two neutral surrogate halves).
 */
const STAND_IN: Record<string, string> = {
	L: "a",
	R: "א",
	AL: "ا",
	AN: "٣",
	EN: "3",
	ON: "!",
	WS: " ",
	ET: "%",
	ES: "+",
	CS: ",",
	NSM: "̀",
	BN: "­",
	B: " ",
	S: "\t",
};

function probeChar(cell: GhosttyCell, engine: BidiEngine): string {
	const codepoint = cell.codepoint === 0 ? BLANK : cell.codepoint;
	if (codepoint <= 0xffff) return String.fromCharCode(codepoint);
	const type = engine.getBidiCharTypeName(String.fromCodePoint(codepoint));
	return STAND_IN[type] ?? STAND_IN.L;
}

/**
 * Reorder one row for display per UAX#9, with the paragraph direction forced to
 * LTR: implicit RTL runs reverse in place, so prompts, indentation and box
 * drawing never move. Returns null when the row renders identically as-is —
 * the caller must then use the original array untouched.
 *
 * Cells are never mutated. A cluster is one cell with `width !== 0` plus every
 * consecutive `width === 0` cell after it (wide-char spacer or combining mark —
 * the rule holds for both), and clusters never reverse internally.
 */
export function reorderRow(
	cells: readonly GhosttyCell[],
	engine: BidiEngine = defaultBidiEngine(),
): ReorderedRow | null {
	if (cells.length === 0 || !rowNeedsBidi(cells)) return null;

	const clusterStarts: number[] = [];
	let probe = "";
	for (let i = 0; i < cells.length; i++) {
		if (i === 0 || cells[i].width !== 0) {
			clusterStarts.push(i);
			probe += probeChar(cells[i], engine);
		}
	}

	const levels = engine.getEmbeddingLevels(probe, "ltr");
	const segments = engine.getReorderSegments(probe, levels);
	const mirrors = engine.getMirroredCharactersMap(probe, levels.levels);
	if (segments.length === 0 && mirrors.size === 0) return null;

	const visualClusters = engine.getReorderedIndices(probe, levels);
	const out: GhosttyCell[] = [];
	const visualToLogical = new Int32Array(cells.length);
	const logicalToVisual = new Int32Array(cells.length);

	for (const cluster of visualClusters) {
		const from = clusterStarts[cluster];
		const to =
			cluster + 1 < clusterStarts.length ? clusterStarts[cluster + 1] : cells.length;
		const mirror = mirrors.get(cluster);
		for (let i = from; i < to; i++) {
			const visual = out.length;
			const cell = cells[i];
			// UAX#9 L4: a mirrored glyph is a different codepoint, so this one cell
			// is cloned. Grapheme cells keep their text — brackets are never graphemes.
			out.push(
				i === from && mirror !== undefined && cell.grapheme_len === 0
					? { ...cell, codepoint: mirror.codePointAt(0) ?? cell.codepoint }
					: cell,
			);
			visualToLogical[visual] = i;
			logicalToVisual[i] = visual;
		}
	}

	return { cells: out, visualToLogical, logicalToVisual };
}
