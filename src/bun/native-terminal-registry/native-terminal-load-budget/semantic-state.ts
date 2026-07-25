/**
 * Deterministic semantic-state builder for the harness fake parser core.
 *
 * The persisted parser-state snapshot embeds a full semantic screen plus capped
 * scrollback, so its serialized size is a real, bounded budget the integration
 * work must plan storage for. This builder produces a schema-valid state of a
 * chosen geometry, letting the harness measure that snapshot size exactly while
 * the parser-state validator confirms the shape is legal.
 */

import type { NativeSemanticLine, NativeSemanticState } from "../ghostty-live";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 ";

function cellText(row: number, col: number): string {
	return ALPHABET[(row * 7 + col * 3) % ALPHABET.length];
}

function buildLine(row: number, cols: number, wrapped: boolean | null): NativeSemanticLine {
	const cells = Array.from({ length: cols }, (_, col) => ({
		text: cellText(row, col),
		width: 1,
		foreground: "rgb:c0c0c0",
		background: "rgb:000000",
		attributes: [] as string[],
	}));
	return { text: cells.map((c) => c.text).join("").trimEnd(), wrapped, cells };
}

export interface SemanticStateShape {
	cols: number;
	rows: number;
	/** Scrollback lines materialized into the snapshot (capped by inspect()). */
	scrollbackLines: number;
	/** Total scrollback the core holds before the cap — makes the cap explicit. */
	scrollbackLength: number;
	/** Varying this is how a scenario makes two snapshots differ byte-wise. */
	title?: string;
}

/** Build a schema-valid semantic state of the given geometry (deterministic content). */
export function buildSemanticState(shape: SemanticStateShape): NativeSemanticState {
	const scrollbackLines = Math.min(shape.scrollbackLines, shape.scrollbackLength);
	return {
		activeBuffer: "normal",
		title: shape.title ?? "dev3-load-budget",
		dimensions: { cols: shape.cols, rows: shape.rows },
		cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
		modes: {
			applicationCursorKeys: false,
			applicationKeypad: false,
			bracketedPaste: false,
			focusEvents: false,
			insert: false,
			mouseTracking: "none",
			origin: false,
			reverseWraparound: false,
			synchronizedOutput: false,
			wraparound: true,
		},
		screen: Array.from({ length: shape.rows }, (_, row) => buildLine(row, shape.cols, false)),
		scrollback: Array.from({ length: scrollbackLines }, (_, index) => buildLine(index, shape.cols, false)),
		scrollbackLength: shape.scrollbackLength,
	};
}
