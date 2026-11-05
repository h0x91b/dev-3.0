export interface TerminalSearchMatch {
	/** Absolute buffer row: 0 = top of scrollback. */
	row: number;
	/** First cell column of the match. */
	col: number;
	/** Cells the match covers (wide characters count 2). */
	length: number;
}

/** A buffer line flattened to text, with the cell span behind each UTF-16 unit. */
export interface SearchLine {
	text: string;
	col: number[];
	end: number[];
}

interface CellLine {
	length: number;
	getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/** Lowercase one code point, keeping its UTF-16 length so indices hold (İ stays İ); final ς folds to σ. */
function foldChar(chars: string): string {
	const lower = chars.toLowerCase();
	if (lower === "ς") return "σ";
	return lower.length === chars.length ? lower : chars;
}

/**
 * Built per cell: translateToString drops empty and spacer cells, so its
 * indices are not columns. Text is folded per code point, like the query.
 * shortcut: base code point only (getChars drops combining marks), upgrade when ghostty returns full graphemes
 */
export function buildSearchLine(line: CellLine): SearchLine {
	let text = "";
	const col: number[] = [];
	const end: number[] = [];
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x);
		const width = cell?.getWidth() ?? 1;
		if (width === 0) continue;
		const chars = cell?.getChars() || " ";
		text += foldChar(chars);
		for (let i = 0; i < chars.length; i++) {
			col.push(x);
			end.push(x + width);
		}
	}
	const trimmed = text.trimEnd();
	return { text: trimmed, col: col.slice(0, trimmed.length), end: end.slice(0, trimmed.length) };
}

/** Case-insensitive, non-overlapping matches, in buffer order. */
export function findMatches(lines: SearchLine[], query: string): TerminalSearchMatch[] {
	if (!query) return [];
	const needle = Array.from(query, foldChar).join("");
	const found: TerminalSearchMatch[] = [];
	lines.forEach(({ text, col, end }, row) => {
		for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
			found.push({ row, col: col[i], length: end[i + needle.length - 1] - col[i] });
		}
	});
	return found;
}
