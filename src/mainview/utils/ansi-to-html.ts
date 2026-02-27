/**
 * Lightweight ANSI escape code → HTML converter.
 *
 * Handles:
 * - SGR codes (bold, dim, italic, underline, inverse, strikethrough)
 * - Standard 8 colors + bright variants (30-37, 40-47, 90-97, 100-107)
 * - 256-color palette (38;5;N / 48;5;N)
 * - 24-bit true color (38;2;R;G;B / 48;2;R;G;B)
 * - Reset (code 0)
 * - Strips all other escape sequences (cursor movement, OSC, etc.)
 */

const STANDARD_COLORS = [
	"#000000", "#cc0000", "#4e9a06", "#c4a000",
	"#3465a4", "#75507b", "#06989a", "#d3d7cf",
];

const BRIGHT_COLORS = [
	"#555753", "#ef2929", "#8ae234", "#fce94f",
	"#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

function color256(n: number): string {
	if (n < 8) return STANDARD_COLORS[n];
	if (n < 16) return BRIGHT_COLORS[n - 8];
	if (n < 232) {
		// 6x6x6 color cube
		const idx = n - 16;
		const r = Math.floor(idx / 36);
		const g = Math.floor((idx % 36) / 6);
		const b = idx % 6;
		const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		return `rgb(${toHex(r)},${toHex(g)},${toHex(b)})`;
	}
	// Grayscale ramp (232-255)
	const level = 8 + (n - 232) * 10;
	return `rgb(${level},${level},${level})`;
}

interface State {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strikethrough: boolean;
	fg: string | null;
	bg: string | null;
}

function defaultState(): State {
	return {
		bold: false, dim: false, italic: false,
		underline: false, inverse: false, strikethrough: false,
		fg: null, bg: null,
	};
}

function stateToStyle(s: State): string {
	const parts: string[] = [];
	const fg = s.inverse ? s.bg : s.fg;
	const bg = s.inverse ? s.fg : s.bg;
	if (fg) parts.push(`color:${fg}`);
	if (bg) parts.push(`background:${bg}`);
	if (s.bold) parts.push("font-weight:bold");
	if (s.dim) parts.push("opacity:0.5");
	if (s.italic) parts.push("font-style:italic");
	if (s.underline) parts.push("text-decoration:underline");
	if (s.strikethrough) parts.push("text-decoration:line-through");
	return parts.join(";");
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function parseSgr(codes: number[], state: State): void {
	let i = 0;
	while (i < codes.length) {
		const c = codes[i];
		if (c === 0) {
			Object.assign(state, defaultState());
		} else if (c === 1) {
			state.bold = true;
		} else if (c === 2) {
			state.dim = true;
		} else if (c === 3) {
			state.italic = true;
		} else if (c === 4) {
			state.underline = true;
		} else if (c === 7) {
			state.inverse = true;
		} else if (c === 9) {
			state.strikethrough = true;
		} else if (c === 22) {
			state.bold = false;
			state.dim = false;
		} else if (c === 23) {
			state.italic = false;
		} else if (c === 24) {
			state.underline = false;
		} else if (c === 27) {
			state.inverse = false;
		} else if (c === 29) {
			state.strikethrough = false;
		} else if (c >= 30 && c <= 37) {
			state.fg = STANDARD_COLORS[c - 30];
		} else if (c === 38) {
			// Extended foreground
			if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
				state.fg = color256(codes[i + 2]);
				i += 2;
			} else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
				state.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
				i += 4;
			}
		} else if (c === 39) {
			state.fg = null;
		} else if (c >= 40 && c <= 47) {
			state.bg = STANDARD_COLORS[c - 40];
		} else if (c === 48) {
			// Extended background
			if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
				state.bg = color256(codes[i + 2]);
				i += 2;
			} else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
				state.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
				i += 4;
			}
		} else if (c === 49) {
			state.bg = null;
		} else if (c >= 90 && c <= 97) {
			state.fg = BRIGHT_COLORS[c - 90];
		} else if (c >= 100 && c <= 107) {
			state.bg = BRIGHT_COLORS[c - 100];
		}
		i++;
	}
}

// Matches CSI SGR sequences: ESC [ ... m
const SGR_RE = /\x1b\[([0-9;]*)m/g;
// Matches all other escape sequences (CSI, OSC, etc.) to strip them
const OTHER_ESC_RE = /\x1b(?:\[[0-9;?]*[A-Za-ln-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([A-Za-z])/g;

export function ansiToHtml(input: string): string {
	// First, strip all non-SGR escape sequences
	let text = input.replace(OTHER_ESC_RE, "");

	const state = defaultState();
	const result: string[] = [];
	let lastIndex = 0;

	SGR_RE.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = SGR_RE.exec(text)) !== null) {
		// Flush text before this SGR sequence
		if (match.index > lastIndex) {
			const chunk = escapeHtml(text.slice(lastIndex, match.index));
			const style = stateToStyle(state);
			if (style) {
				result.push(`<span style="${style}">${chunk}</span>`);
			} else {
				result.push(chunk);
			}
		}

		// Parse SGR codes
		const rawCodes = match[1];
		const codes = rawCodes === "" ? [0] : rawCodes.split(";").map(Number);
		parseSgr(codes, state);

		lastIndex = match.index + match[0].length;
	}

	// Flush remaining text
	if (lastIndex < text.length) {
		const chunk = escapeHtml(text.slice(lastIndex));
		const style = stateToStyle(state);
		if (style) {
			result.push(`<span style="${style}">${chunk}</span>`);
		} else {
			result.push(chunk);
		}
	}

	return result.join("");
}
