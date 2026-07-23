/**
 * Backend-neutral terminal sinks for the stream-resync spike (see ./README.md).
 *
 * The sequencing rule treats a terminal as any deterministic reducer that can
 * apply ordered ops and capture/restore a self-contained state. This file
 * provides two such reducers, proving the rule does not depend on one backend:
 *
 *   • GridTerminal      — a compact, BOUNDED semantic snapshot (cells + cursor +
 *                          decoder/parser continuation), like a future native
 *                          state export.
 *   • ByteJournalTerminal — an UNBOUNDED ordered op journal, like the sibling
 *                          terminal-state event-journal spike; its restore is
 *                          byte-exact by construction.
 *
 * The renderer's real Ghostty core (the terminal-state spike) satisfies the same
 * ResyncSink shape via an event journal, so production reconstruction is already
 * covered there. Nothing here loads WASM: pure, fast, deterministic.
 */

export interface ResyncSink {
	applyOutput(data: Uint8Array): void;
	applyResize(cols: number, rows: number): void;
	/** Self-contained, JSON-serializable state at the current position. */
	captureState(): unknown;
	restoreState(state: unknown): void;
}

export interface SinkFactory {
	name: string;
	create(dimensions: { cols: number; rows: number }): ResyncSink;
}

interface GridState {
	cols: number;
	rows: number;
	cursorX: number;
	cursorY: number;
	grid: string[];
	parser: "ground" | "esc" | "csi";
	csi: string;
	pending: number[];
	pendingNeeded: number;
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

/**
 * A minimal but real VT reducer over raw bytes. It intentionally captures the
 * in-progress UTF-8 and escape-parser state so a snapshot restores losslessly at
 * ANY byte boundary — including a multi-byte glyph or CSI split across a dropped
 * frame. Cell width, colors, and scrollback are out of scope (the Ghostty spike
 * owns those); every codepoint here is one cell.
 */
export class GridTerminal implements ResyncSink {
	private cols: number;
	private rows: number;
	private cursorX = 0;
	private cursorY = 0;
	private grid: string[][];
	private parser: "ground" | "esc" | "csi" = "ground";
	private csi = "";
	private pending: number[] = [];
	private pendingNeeded = 0;

	constructor(dimensions: { cols: number; rows: number }) {
		this.cols = dimensions.cols;
		this.rows = dimensions.rows;
		this.grid = Array.from({ length: this.rows }, () => this.blankRow());
	}

	applyOutput(data: Uint8Array): void {
		for (const byte of data) this.consume(byte);
	}

	applyResize(cols: number, rows: number): void {
		const next = Array.from({ length: rows }, (_, y) => {
			const row = this.blankRow(cols);
			const source = this.grid[y];
			if (source) for (let x = 0; x < Math.min(cols, this.cols); x++) row[x] = source[x];
			return row;
		});
		this.cols = cols;
		this.rows = rows;
		this.grid = next;
		this.cursorX = clamp(this.cursorX, 0, cols - 1);
		this.cursorY = clamp(this.cursorY, 0, rows - 1);
	}

	captureState(): GridState {
		return {
			cols: this.cols,
			rows: this.rows,
			cursorX: this.cursorX,
			cursorY: this.cursorY,
			grid: this.grid.map((row) => row.join("")),
			parser: this.parser,
			csi: this.csi,
			pending: [...this.pending],
			pendingNeeded: this.pendingNeeded,
		};
	}

	restoreState(state: unknown): void {
		const s = state as GridState;
		this.cols = s.cols;
		this.rows = s.rows;
		this.cursorX = s.cursorX;
		this.cursorY = s.cursorY;
		this.grid = s.grid.map((row) => {
			const cells = [...row];
			while (cells.length < this.cols) cells.push(" ");
			return cells.slice(0, this.cols);
		});
		this.parser = s.parser;
		this.csi = s.csi;
		this.pending = [...s.pending];
		this.pendingNeeded = s.pendingNeeded;
	}

	render(): string {
		return this.grid.map((row) => row.join("")).join("\n");
	}

	private blankRow(cols = this.cols): string[] {
		return Array.from({ length: cols }, () => " ");
	}

	private consume(byte: number): void {
		if (this.parser === "csi") {
			const char = String.fromCharCode(byte);
			if (byte >= 0x40 && byte <= 0x7e) {
				this.execCsi(this.csi, char);
				this.csi = "";
				this.parser = "ground";
			} else {
				this.csi += char;
				if (this.csi.length > 64) {
					this.csi = "";
					this.parser = "ground";
				}
			}
			return;
		}
		if (this.parser === "esc") {
			if (byte === 0x5b) {
				this.csi = "";
				this.parser = "csi";
			} else {
				this.parser = "ground";
			}
			return;
		}
		if (this.pendingNeeded > 0) {
			if (byte >= 0x80 && byte <= 0xbf) {
				this.pending.push(byte);
				if (this.pending.length === this.pendingNeeded) {
					this.putChar(new TextDecoder().decode(Uint8Array.from(this.pending)));
					this.pending = [];
					this.pendingNeeded = 0;
				}
				return;
			}
			this.putChar("�");
			this.pending = [];
			this.pendingNeeded = 0;
		}
		if (byte === 0x1b) {
			this.parser = "esc";
			return;
		}
		if (byte < 0x80) {
			this.handleAscii(byte);
			return;
		}
		if (byte >= 0xc0 && byte <= 0xdf) {
			this.pending = [byte];
			this.pendingNeeded = 2;
			return;
		}
		if (byte >= 0xe0 && byte <= 0xef) {
			this.pending = [byte];
			this.pendingNeeded = 3;
			return;
		}
		if (byte >= 0xf0 && byte <= 0xf7) {
			this.pending = [byte];
			this.pendingNeeded = 4;
			return;
		}
		this.putChar("�");
	}

	private handleAscii(byte: number): void {
		switch (byte) {
			case 0x0a:
				this.cursorY++;
				this.scrollIfNeeded();
				return;
			case 0x0d:
				this.cursorX = 0;
				return;
			case 0x08:
				if (this.cursorX > 0) this.cursorX--;
				return;
			case 0x09:
				this.cursorX = Math.min((Math.floor(this.cursorX / 8) + 1) * 8, this.cols - 1);
				return;
			case 0x07:
				return;
			default:
				if (byte >= 0x20 && byte <= 0x7e) this.putChar(String.fromCharCode(byte));
		}
	}

	private putChar(char: string): void {
		if (this.cursorX >= this.cols) {
			this.cursorX = 0;
			this.cursorY++;
			this.scrollIfNeeded();
		}
		this.grid[this.cursorY][this.cursorX] = char;
		this.cursorX++;
	}

	private scrollIfNeeded(): void {
		while (this.cursorY >= this.rows) {
			this.grid.shift();
			this.grid.push(this.blankRow());
			this.cursorY--;
		}
	}

	private execCsi(params: string, final: string): void {
		if (params.startsWith("?")) return;
		const nums = params.split(";").map((part) => (part === "" ? undefined : Number(part)));
		const first = nums[0] ?? 1;
		switch (final) {
			case "H":
			case "f":
				this.cursorY = clamp((nums[0] ?? 1) - 1, 0, this.rows - 1);
				this.cursorX = clamp((nums[1] ?? 1) - 1, 0, this.cols - 1);
				return;
			case "A":
				this.cursorY = clamp(this.cursorY - first, 0, this.rows - 1);
				return;
			case "B":
				this.cursorY = clamp(this.cursorY + first, 0, this.rows - 1);
				return;
			case "C":
				this.cursorX = clamp(this.cursorX + first, 0, this.cols - 1);
				return;
			case "D":
				this.cursorX = clamp(this.cursorX - first, 0, this.cols - 1);
				return;
			case "J":
				this.eraseDisplay(nums[0] ?? 0);
				return;
			case "K":
				this.eraseLine(nums[0] ?? 0);
				return;
		}
	}

	private eraseDisplay(mode: number): void {
		if (mode === 2 || mode === 3) {
			this.grid = Array.from({ length: this.rows }, () => this.blankRow());
			return;
		}
		if (mode === 0) {
			this.eraseLine(0);
			for (let y = this.cursorY + 1; y < this.rows; y++) this.grid[y] = this.blankRow();
		} else if (mode === 1) {
			this.eraseLine(1);
			for (let y = 0; y < this.cursorY; y++) this.grid[y] = this.blankRow();
		}
	}

	private eraseLine(mode: number): void {
		const row = this.grid[this.cursorY];
		if (mode === 2) {
			for (let x = 0; x < this.cols; x++) row[x] = " ";
		} else if (mode === 1) {
			for (let x = 0; x <= this.cursorX && x < this.cols; x++) row[x] = " ";
		} else {
			for (let x = this.cursorX; x < this.cols; x++) row[x] = " ";
		}
	}
}

interface JournalState {
	ops: Array<{ kind: "output"; data: number[] } | { kind: "resize"; cols: number; rows: number }>;
}

/**
 * Records the ordered op stream verbatim. Its snapshot is the whole journal, so
 * restore + resumed deltas reproduce the exact byte stream — a byte-exact proof
 * that the recovered logical stream equals the uninterrupted one. Unbounded by
 * design; it exists to cross-check GridTerminal, not to ship.
 */
export class ByteJournalTerminal implements ResyncSink {
	private ops: JournalState["ops"] = [];

	applyOutput(data: Uint8Array): void {
		this.ops.push({ kind: "output", data: [...data] });
	}

	applyResize(cols: number, rows: number): void {
		this.ops.push({ kind: "resize", cols, rows });
	}

	captureState(): JournalState {
		return {
			ops: this.ops.map((op) =>
				op.kind === "output" ? { kind: "output", data: [...op.data] } : { ...op },
			),
		};
	}

	restoreState(state: unknown): void {
		const s = state as JournalState;
		this.ops = s.ops.map((op) =>
			op.kind === "output" ? { kind: "output", data: [...op.data] } : { ...op },
		);
	}

	/** Concatenated output bytes, for readable assertions. */
	bytes(): Uint8Array {
		const out: number[] = [];
		for (const op of this.ops) if (op.kind === "output") out.push(...op.data);
		return Uint8Array.from(out);
	}
}

export const GRID_SINK: SinkFactory = {
	name: "grid",
	create: (dimensions) => new GridTerminal(dimensions),
};

export const JOURNAL_SINK: SinkFactory = {
	name: "journal",
	create: () => new ByteJournalTerminal(),
};
