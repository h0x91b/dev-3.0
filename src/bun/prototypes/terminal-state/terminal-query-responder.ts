/**
 * Static terminal-query responder for the Windows capture spike.
 *
 * Real agent TUIs (Claude, Codex) probe the terminal at startup with DSR/DA/mode
 * queries and can stall until they receive answers. The existing capture path
 * answers these by ingesting bytes into a live Ghostty core, but Bun 1.3.14 on
 * Windows returns a negative WASM allocation pointer when Ghostty runs inside a
 * Bun.Terminal data callback (decision 146). This responder answers the common
 * queries with canned, deterministic replies without loading Ghostty, so raw
 * capture stays decoupled from the parser on Windows.
 *
 * The embedded cursor tracker is a coarse approximation used ONLY to answer
 * cursor-position reports during live capture. It does not drive replay: replay
 * fidelity is proven by feeding the captured bytes through a real Ghostty core
 * offline. Wide glyphs, scroll regions, and alternate-screen cursor nuances are
 * not modelled here.
 */

export type QueryKind =
	| "DA1"
	| "DA2"
	| "DSR-status"
	| "DSR-cursor"
	| "DECRQM"
	| "XTVERSION"
	| "kitty-query"
	| "OSC-color";

const ESC = "\x1b";
const BEL = "\x07";

// Canned responses that do not depend on live terminal state.
const DA1_RESPONSE = `${ESC}[?62;22c`;
const DA2_RESPONSE = `${ESC}[>0;10;1c`;
const DSR_STATUS_RESPONSE = `${ESC}[0n`;
const XTVERSION_RESPONSE = `${ESC}P>|dev3-spike(0.1)${ESC}\\`;
const KITTY_QUERY_RESPONSE = `${ESC}[?0u`;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export class TerminalQueryResponder {
	private cols: number;
	private rows: number;
	private cursorRow = 1;
	private cursorCol = 1;
	private savedRow = 1;
	private savedCol = 1;
	private readonly decoder = new TextDecoder();
	private state: "ground" | "escape" | "csi" | "osc" | "osc-escape" = "ground";
	private sequence = "";
	private readonly responses: string[] = [];
	readonly counts: Record<QueryKind, number> = {
		DA1: 0,
		DA2: 0,
		"DSR-status": 0,
		"DSR-cursor": 0,
		DECRQM: 0,
		XTVERSION: 0,
		"kitty-query": 0,
		"OSC-color": 0,
	};

	constructor(cols: number, rows: number) {
		this.cols = cols;
		this.rows = rows;
	}

	ingest(data: string | Uint8Array): void {
		const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
		for (const char of text) this.consume(char);
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		this.cursorRow = clamp(this.cursorRow, 1, rows);
		this.cursorCol = clamp(this.cursorCol, 1, cols);
	}

	takeResponses(): string[] {
		return this.responses.splice(0, this.responses.length);
	}

	private record(kind: QueryKind, response: string): void {
		this.counts[kind] += 1;
		this.responses.push(response);
	}

	private consume(char: string): void {
		switch (this.state) {
			case "ground":
				this.consumeGround(char);
				return;
			case "escape":
				if (char === "[") {
					this.sequence = "";
					this.state = "csi";
				} else if (char === "]") {
					this.sequence = "";
					this.state = "osc";
				} else {
					this.state = "ground";
				}
				return;
			case "csi": {
				const code = char.charCodeAt(0);
				if (code >= 0x40 && code <= 0x7e) {
					this.consumeCsi(this.sequence, char);
					this.sequence = "";
					this.state = "ground";
				} else if (this.sequence.length < 64) {
					this.sequence += char;
				}
				return;
			}
			case "osc":
				if (char === BEL) {
					this.consumeOsc(this.sequence);
					this.sequence = "";
					this.state = "ground";
				} else if (char === ESC) {
					this.state = "osc-escape";
				} else if (this.sequence.length < 256) {
					this.sequence += char;
				}
				return;
			case "osc-escape":
				if (char === "\\") {
					this.consumeOsc(this.sequence);
					this.sequence = "";
					this.state = "ground";
				} else {
					this.sequence += `${ESC}${char}`;
					this.state = "osc";
				}
		}
	}

	private consumeGround(char: string): void {
		if (char === ESC) {
			this.state = "escape";
			return;
		}
		if (char === "\r") {
			this.cursorCol = 1;
			return;
		}
		if (char === "\n") {
			this.cursorRow = clamp(this.cursorRow + 1, 1, this.rows);
			return;
		}
		if (char === "\b") {
			this.cursorCol = Math.max(1, this.cursorCol - 1);
			return;
		}
		if (char === "\t") {
			this.cursorCol = clamp(this.cursorCol + (8 - ((this.cursorCol - 1) % 8)), 1, this.cols);
			return;
		}
		if (char.charCodeAt(0) < 0x20) return;
		// Approximate every printable grapheme as one cell wide.
		if (this.cursorCol >= this.cols) {
			this.cursorCol = 1;
			this.cursorRow = clamp(this.cursorRow + 1, 1, this.rows);
		} else {
			this.cursorCol += 1;
		}
	}

	private consumeCsi(body: string, final: string): void {
		const prefix = /^[?><=]/.test(body) ? body[0] : "";
		const core = prefix ? body.slice(1) : body;
		this.trackCursor(prefix, core, final);
		if (final === "c") {
			if (prefix === ">") this.record("DA2", DA2_RESPONSE);
			else if (prefix === "" && (core === "" || core === "0")) this.record("DA1", DA1_RESPONSE);
			return;
		}
		if (final === "n" && prefix === "") {
			if (core === "5") this.record("DSR-status", DSR_STATUS_RESPONSE);
			else if (core === "6")
				this.record("DSR-cursor", `${ESC}[${this.cursorRow};${this.cursorCol}R`);
			return;
		}
		if (final === "p" && prefix === "?" && core.endsWith("$")) {
			const mode = core.slice(0, -1).split(";")[0];
			if (mode) this.record("DECRQM", `${ESC}[?${mode};0$y`);
			return;
		}
		if (final === "q" && prefix === ">") {
			this.record("XTVERSION", XTVERSION_RESPONSE);
			return;
		}
		if (final === "u" && prefix === "?" && core === "") this.record("kitty-query", KITTY_QUERY_RESPONSE);
	}

	private trackCursor(prefix: string, core: string, final: string): void {
		if (prefix !== "") return;
		const params = core.split(";").map((value) => Number(value || 0));
		const first = params[0] || 0;
		switch (final) {
			case "H":
			case "f":
				this.cursorRow = clamp(params[0] || 1, 1, this.rows);
				this.cursorCol = clamp(params[1] || 1, 1, this.cols);
				return;
			case "A":
				this.cursorRow = clamp(this.cursorRow - (first || 1), 1, this.rows);
				return;
			case "B":
			case "e":
				this.cursorRow = clamp(this.cursorRow + (first || 1), 1, this.rows);
				return;
			case "C":
			case "a":
				this.cursorCol = clamp(this.cursorCol + (first || 1), 1, this.cols);
				return;
			case "D":
				this.cursorCol = clamp(this.cursorCol - (first || 1), 1, this.cols);
				return;
			case "E":
				this.cursorRow = clamp(this.cursorRow + (first || 1), 1, this.rows);
				this.cursorCol = 1;
				return;
			case "F":
				this.cursorRow = clamp(this.cursorRow - (first || 1), 1, this.rows);
				this.cursorCol = 1;
				return;
			case "G":
			case "`":
				this.cursorCol = clamp(first || 1, 1, this.cols);
				return;
			case "d":
				this.cursorRow = clamp(first || 1, 1, this.rows);
				return;
			case "s":
				this.savedRow = this.cursorRow;
				this.savedCol = this.cursorCol;
				return;
			case "u":
				this.cursorRow = this.savedRow;
				this.cursorCol = this.savedCol;
		}
	}

	private consumeOsc(sequence: string): void {
		if (!sequence.endsWith(";?")) return;
		const parts = sequence.split(";");
		const command = parts[0];
		if (command === "10") this.record("OSC-color", `${ESC}]10;rgb:ffff/ffff/ffff${BEL}`);
		else if (command === "11") this.record("OSC-color", `${ESC}]11;rgb:0000/0000/0000${BEL}`);
		else if (command === "4" && parts.length >= 3)
			this.record("OSC-color", `${ESC}]4;${parts[1]};rgb:0000/0000/0000${BEL}`);
	}
}
