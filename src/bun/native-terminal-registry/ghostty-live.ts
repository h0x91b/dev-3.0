/**
 * Registry-local Ghostty VT wrapper for the live-parser proof (seq 1228).
 *
 * Owns exactly what the live parser needs from `ghostty-web`: WASM load with a
 * fail-closed version pin, byte ingestion, resize, drain of parser-generated
 * terminal replies (DSR/DA/…); and a semantic screen inspection compatible with
 * the renderer's parser semantics. Deliberately self-contained: the registry
 * module must not import the removable `prototypes/` spikes (isolation test),
 * so this mirrors the spike's proven inspection shape locally.
 *
 * Each parser gets its own WASM instance — a shared instance corrupted grapheme
 * reads during create/free churn in the spike (see decision 146); a host owns
 * one terminal anyway, so per-instance cost is paid once per session.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CellFlags, Ghostty, type GhosttyCell, type GhosttyTerminal } from "ghostty-web";

export interface NativeSemanticCell {
	text: string;
	width: number;
	foreground: string;
	background: string;
	attributes: string[];
}

export interface NativeSemanticLine {
	text: string;
	wrapped: boolean | null;
	cells: NativeSemanticCell[];
}

export interface NativeTerminalModes {
	applicationCursorKeys: boolean;
	applicationKeypad: boolean;
	bracketedPaste: boolean;
	focusEvents: boolean;
	insert: boolean;
	mouseTracking: "none" | "x10" | "vt200" | "drag" | "any";
	origin: boolean;
	reverseWraparound: boolean;
	synchronizedOutput: boolean;
	wraparound: boolean;
}

export interface NativeSemanticState {
	activeBuffer: "normal" | "alternate";
	title: string;
	dimensions: { cols: number; rows: number };
	cursor: {
		x: number;
		y: number;
		visible: boolean;
		style: "block" | "underline" | "bar";
		blink: boolean;
	};
	modes: NativeTerminalModes;
	screen: NativeSemanticLine[];
	/** Trailing scrollback lines, capped by the inspect() caller's limit. */
	scrollback: NativeSemanticLine[];
	/** Total scrollback length before capping — makes the cap explicit. */
	scrollbackLength: number;
}

const wasmPath = fileURLToPath(new URL("../../../node_modules/ghostty-web/dist/ghostty-vt.wasm", import.meta.url));
const packagePath = fileURLToPath(new URL("../../../node_modules/ghostty-web/package.json", import.meta.url));

const GHOSTTY_VERSION = "0.4.0" as const;
export const LIVE_PARSER_ID = `ghostty-web@${GHOSTTY_VERSION}` as const;

function assertGhosttyPackageVersion(): void {
	const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
	if (metadata.version !== GHOSTTY_VERSION) {
		throw new Error(
			`Native-session live parser requires ${LIVE_PARSER_ID}; installed ghostty-web is ${String(metadata.version)}`,
		);
	}
}

let wasmModulePromise: Promise<WebAssembly.Module> | undefined;

async function loadGhostty(): Promise<Ghostty> {
	wasmModulePromise ??= (async () => {
		assertGhosttyPackageVersion();
		const bytes = readFileSync(wasmPath);
		const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		return WebAssembly.compile(source);
	})();
	const instance = await WebAssembly.instantiate(await wasmModulePromise, {
		env: { log: (_pointer: number, _length: number) => {} },
	});
	return new Ghostty(instance);
}

function rgb(r: number, g: number, b: number): string {
	return `rgb:${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function cellAttributes(flags: number): string[] {
	const attributes: string[] = [];
	if (flags & CellFlags.BOLD) attributes.push("bold");
	if (flags & CellFlags.ITALIC) attributes.push("italic");
	if (flags & CellFlags.FAINT) attributes.push("dim");
	if (flags & CellFlags.UNDERLINE) attributes.push("underline");
	if (flags & CellFlags.BLINK) attributes.push("blink");
	if (flags & CellFlags.INVERSE) attributes.push("inverse");
	if (flags & CellFlags.INVISIBLE) attributes.push("invisible");
	if (flags & CellFlags.STRIKETHROUGH) attributes.push("strikethrough");
	return attributes;
}

function inspectLine(
	cells: GhosttyCell[] | null,
	graphemeAt: (col: number) => string,
	wrapped: boolean | null,
): NativeSemanticLine {
	if (!cells) return { text: "", wrapped, cells: [] };
	const semanticCells = cells.map((cell, col) => {
		const text =
			cell.codepoint === 0 ? "" : cell.grapheme_len > 0 ? graphemeAt(col) : String.fromCodePoint(cell.codepoint);
		return {
			text,
			width: cell.width,
			foreground: rgb(cell.fg_r, cell.fg_g, cell.fg_b),
			background: rgb(cell.bg_r, cell.bg_g, cell.bg_b),
			attributes: cellAttributes(cell.flags),
		};
	});
	let text = "";
	for (const cell of semanticCells) {
		if (cell.width === 0) continue;
		text += cell.text || " ".repeat(Math.max(1, cell.width));
	}
	return { text: text.trimEnd(), wrapped, cells: semanticCells };
}

/**
 * A pane's screen as PLAIN TEXT rows and nothing else (seq 1412).
 *
 * The per-cell {@link NativeSemanticState} costs multiple MiB per pane to build
 * and to serialise; a read-only capture needs none of it — no colours, no
 * attributes, no cursor, no modes. This is the whole payload a capture actually
 * uses, and building it allocates row strings instead of one object per cell.
 */
export interface NativeTextProjection {
	activeBuffer: "normal" | "alternate";
	dimensions: { cols: number; rows: number };
	/** Physical rows of the visible screen, top row first. */
	viewport: string[];
	/** Physical rows that scrolled off, oldest first, capped by the caller. */
	history: string[];
	/** Total scrollback depth the parser holds, before the cap. */
	historyTotal: number;
}

/**
 * The text of one row, WITHOUT materialising a cell object per column. Same
 * width and grapheme rules as {@link inspectLine} — zero-width cells are joined
 * onto their base, a blank cell contributes its own width in spaces — so the two
 * paths cannot disagree about what a row says.
 */
function projectLine(cells: GhosttyCell[] | null, graphemeAt: (col: number) => string): string {
	if (!cells) return "";
	let text = "";
	for (let col = 0; col < cells.length; col++) {
		const cell = cells[col]!;
		if (cell.width === 0) continue;
		const glyph =
			cell.codepoint === 0 ? "" : cell.grapheme_len > 0 ? graphemeAt(col) : String.fromCodePoint(cell.codepoint);
		text += glyph || " ".repeat(Math.max(1, cell.width));
	}
	return text.trimEnd();
}

/**
 * Title + cursor-presentation tracker. Ghostty's JS surface exposes no title
 * and the renderer derives cursor presentation from the same escape sequences,
 * so the live parser mirrors that tracking for renderer-compatible semantics.
 */
class PresentationTracker {
	title = "";
	readonly cursor = { visible: true, style: "block" as "block" | "underline" | "bar", blink: false };
	private readonly decoder = new TextDecoder();
	private state: "ground" | "escape" | "csi" | "osc" | "osc-escape" = "ground";
	private sequence = "";

	ingest(data: string | Uint8Array): void {
		const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
		for (const char of text) this.consume(char);
	}

	private consume(char: string): void {
		switch (this.state) {
			case "ground":
				if (char === "\x1b") this.state = "escape";
				return;
			case "escape":
				if (char === "[") {
					this.sequence = "";
					this.state = "csi";
				} else if (char === "]") {
					this.sequence = "";
					this.state = "osc";
				} else {
					if (char === "c") this.reset();
					this.state = "ground";
				}
				return;
			case "csi": {
				const code = char.charCodeAt(0);
				if (code >= 0x40 && code <= 0x7e) {
					this.consumeCsi(this.sequence, char);
					this.sequence = "";
					this.state = "ground";
				} else if (this.sequence.length < 256) {
					this.sequence += char;
				}
				return;
			}
			case "osc":
				if (char === "\x07") {
					this.consumeOsc(this.sequence);
					this.sequence = "";
					this.state = "ground";
				} else if (char === "\x1b") {
					this.state = "osc-escape";
				} else if (this.sequence.length < 8192) {
					this.sequence += char;
				}
				return;
			case "osc-escape":
				if (char === "\\") {
					this.consumeOsc(this.sequence);
					this.sequence = "";
					this.state = "ground";
				} else {
					this.sequence += `\x1b${char}`;
					this.state = "osc";
				}
		}
	}

	private consumeCsi(parameters: string, final: string): void {
		if (parameters.startsWith("?") && (final === "h" || final === "l")) {
			const enabled = final === "h";
			for (const value of parameters.slice(1).split(";").map(Number)) {
				if (value === 12) this.cursor.blink = enabled;
				if (value === 25) this.cursor.visible = enabled;
			}
			return;
		}
		if (final !== "q" || !parameters.endsWith(" ")) return;
		const value = Number(parameters.trim() || 0);
		if (value === 0 || value === 1) Object.assign(this.cursor, { style: "block", blink: true });
		if (value === 2) Object.assign(this.cursor, { style: "block", blink: false });
		if (value === 3) Object.assign(this.cursor, { style: "underline", blink: true });
		if (value === 4) Object.assign(this.cursor, { style: "underline", blink: false });
		if (value === 5) Object.assign(this.cursor, { style: "bar", blink: true });
		if (value === 6) Object.assign(this.cursor, { style: "bar", blink: false });
	}

	private consumeOsc(sequence: string): void {
		const separator = sequence.indexOf(";");
		if (separator < 0) return;
		const command = sequence.slice(0, separator);
		if (command === "0" || command === "2") this.title = sequence.slice(separator + 1);
	}

	private reset(): void {
		this.title = "";
		Object.assign(this.cursor, { visible: true, style: "block", blink: false });
	}
}

export interface GhosttyLiveOptions {
	cols: number;
	rows: number;
	scrollbackLimit: number;
}

/** The narrow parser surface the pipeline needs — fakeable in unit tests. */
export interface LiveParserCore {
	ingest(data: Uint8Array): void;
	resize(cols: number, rows: number): void;
	readResponses(): string[];
	inspect(scrollbackCap: number): NativeSemanticState;
	/** The same screen as {@link inspect}, as plain rows only (seq 1412). */
	project(scrollbackCap: number): NativeTextProjection;
	dispose(): void;
}

export class GhosttyLiveParser implements LiveParserCore {
	private readonly presentation = new PresentationTracker();

	private constructor(private readonly terminal: GhosttyTerminal) {}

	static async create(options: GhosttyLiveOptions): Promise<GhosttyLiveParser> {
		const ghostty = await loadGhostty();
		return new GhosttyLiveParser(
			ghostty.createTerminal(options.cols, options.rows, { scrollbackLimit: options.scrollbackLimit }),
		);
	}

	ingest(data: Uint8Array): void {
		this.terminal.write(data);
		this.presentation.ingest(data);
	}

	resize(cols: number, rows: number): void {
		this.terminal.resize(cols, rows);
	}

	/** Drain parser-generated terminal replies (DSR/DA/…), oldest first. */
	readResponses(): string[] {
		const responses: string[] = [];
		while (this.terminal.hasResponse()) {
			const response = this.terminal.readResponse();
			if (response === null) break;
			responses.push(response);
		}
		return responses;
	}

	inspect(scrollbackCap: number): NativeSemanticState {
		this.terminal.update();
		const cursor = this.terminal.getCursor();
		const scrollbackLength = this.terminal.getScrollbackLength();
		const scrollbackStart = Math.max(0, scrollbackLength - Math.max(0, scrollbackCap));
		const viewport = this.terminal.getViewport().map((cell) => ({ ...cell }));
		const mouseTracking: NativeTerminalModes["mouseTracking"] = this.terminal.getMode(1003)
			? "any"
			: this.terminal.getMode(1002)
				? "drag"
				: this.terminal.getMode(1000)
					? "vt200"
					: this.terminal.getMode(9)
						? "x10"
						: "none";
		return {
			activeBuffer: this.terminal.isAlternateScreen() ? "alternate" : "normal",
			title: this.presentation.title,
			dimensions: this.terminal.getDimensions(),
			cursor: {
				x: cursor.x,
				y: cursor.y,
				visible: this.presentation.cursor.visible,
				style: this.presentation.cursor.style,
				blink: this.presentation.cursor.blink,
			},
			modes: {
				applicationCursorKeys: Boolean(this.terminal.getMode(1)),
				applicationKeypad: Boolean(this.terminal.getMode(66)),
				bracketedPaste: Boolean(this.terminal.getMode(2004)),
				focusEvents: Boolean(this.terminal.getMode(1004)),
				insert: Boolean(this.terminal.getMode(4, true)),
				mouseTracking,
				origin: Boolean(this.terminal.getMode(6)),
				reverseWraparound: Boolean(this.terminal.getMode(45)),
				synchronizedOutput: Boolean(this.terminal.getMode(2026)),
				wraparound: Boolean(this.terminal.getMode(7)),
			},
			screen: Array.from({ length: this.terminal.rows }, (_, row) =>
				inspectLine(
					viewport.slice(row * this.terminal.cols, (row + 1) * this.terminal.cols),
					(col) => this.terminal.getGraphemeString(row, col),
					this.terminal.isRowWrapped(row),
				),
			),
			scrollback: Array.from({ length: scrollbackLength - scrollbackStart }, (_, index) =>
				inspectLine(
					this.terminal.getScrollbackLine(scrollbackStart + index),
					(col) => this.terminal.getScrollbackGraphemeString(scrollbackStart + index, col),
					false,
				),
			),
			scrollbackLength,
		};
	}

	project(scrollbackCap: number): NativeTextProjection {
		this.terminal.update();
		const cols = this.terminal.cols;
		const rows = this.terminal.rows;
		const historyTotal = this.terminal.getScrollbackLength();
		const historyStart = Math.max(0, historyTotal - Math.max(0, scrollbackCap));
		// No per-cell copy: the viewport is read once and sliced in place.
		const viewport = this.terminal.getViewport();
		return {
			activeBuffer: this.terminal.isAlternateScreen() ? "alternate" : "normal",
			dimensions: this.terminal.getDimensions(),
			viewport: Array.from({ length: rows }, (_, row) =>
				projectLine(viewport.slice(row * cols, (row + 1) * cols), (col) =>
					this.terminal.getGraphemeString(row, col),
				),
			),
			history: Array.from({ length: historyTotal - historyStart }, (_, index) =>
				projectLine(this.terminal.getScrollbackLine(historyStart + index), (col) =>
					this.terminal.getScrollbackGraphemeString(historyStart + index, col),
				),
			),
			historyTotal,
		};
	}

	dispose(): void {
		this.terminal.free();
	}
}
