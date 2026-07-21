import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CellFlags, Ghostty, type GhosttyCell, type GhosttyTerminal } from "ghostty-web";
import type { TerminalDimensions, TerminalModeState } from "./terminal-state";

export interface RendererSemanticCell {
	text: string;
	width: number;
	foreground: string;
	background: string;
	attributes: string[];
}

export interface RendererSemanticLine {
	text: string;
	wrapped: boolean | null;
	cells: RendererSemanticCell[];
}

export interface RendererSemanticState {
	activeBuffer: "normal" | "alternate";
	dimensions: {
		cols: number;
		rows: number;
	};
	cursor: {
		x: number;
		y: number;
		visible: boolean;
		style: "block" | "underline" | "bar";
		blink: boolean;
	};
	modes: TerminalModeState;
	screen: RendererSemanticLine[];
	scrollback: RendererSemanticLine[];
}

const wasmPath = fileURLToPath(
	new URL("../../../../node_modules/ghostty-web/dist/ghostty-vt.wasm", import.meta.url),
);
const packagePath = fileURLToPath(
	new URL("../../../../node_modules/ghostty-web/package.json", import.meta.url),
);

const GHOSTTY_VERSION = "0.4.0" as const;
export const GHOSTTY_PARSER_ID = `ghostty-web@${GHOSTTY_VERSION}` as const;

function assertGhosttyPackageVersion(): void {
	const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
	if (metadata.version !== GHOSTTY_VERSION) {
		throw new Error(
			`Terminal-state spike requires ${GHOSTTY_PARSER_ID}; installed ghostty-web is ${String(metadata.version)}`,
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
			env: {
				log: (_pointer: number, _length: number) => {},
			},
	});
	return new Ghostty(instance);
}

function rgb(r: number, g: number, b: number): string {
	return `rgb:${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
		.toString(16)
		.padStart(2, "0")}`;
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
): RendererSemanticLine {
	if (!cells) return { text: "", wrapped, cells: [] };
	const semanticCells = cells.map((cell, col) => {
		const text =
			cell.codepoint === 0
				? ""
				: cell.grapheme_len > 0
					? graphemeAt(col)
					: String.fromCodePoint(cell.codepoint);
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

export class GhosttyRendererProbe {
	private constructor(private readonly terminal: GhosttyTerminal) {}

	static async create(options: TerminalDimensions): Promise<GhosttyRendererProbe> {
		const ghostty = await loadGhostty();
		return new GhosttyRendererProbe(
			ghostty.createTerminal(options.cols, options.rows, { scrollbackLimit: options.scrollback }),
		);
	}

	ingest(data: string | Uint8Array): void {
		this.terminal.write(data);
	}

	resize(cols: number, rows: number): void {
		this.terminal.resize(cols, rows);
	}

	readResponses(): string[] {
		const responses: string[] = [];
		while (this.terminal.hasResponse()) {
			const response = this.terminal.readResponse();
			if (response === null) break;
			responses.push(response);
		}
		return responses;
	}

	inspect(): RendererSemanticState {
		this.terminal.update();
		const cursor = this.terminal.getCursor();
		const scrollbackLength = this.terminal.getScrollbackLength();
		const viewport = this.terminal.getViewport().map((cell) => ({ ...cell }));
		const mouseTracking: TerminalModeState["mouseTracking"] = this.terminal.getMode(1003)
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
			dimensions: this.terminal.getDimensions(),
			cursor: {
				x: cursor.x,
				y: cursor.y,
				visible: Boolean(cursor.visible),
				style: cursor.style,
				blink: Boolean(cursor.blinking),
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
			scrollback: Array.from({ length: scrollbackLength }, (_, row) =>
				inspectLine(
					this.terminal.getScrollbackLine(row),
					(col) => this.terminal.getScrollbackGraphemeString(row, col),
					false,
				),
			),
		};
	}

	dispose(): void {
		this.terminal.free();
	}
}
