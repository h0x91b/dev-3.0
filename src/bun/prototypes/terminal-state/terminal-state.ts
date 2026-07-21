import {
	GHOSTTY_PARSER_ID,
	GhosttyRendererProbe,
	type RendererSemanticCell,
	type RendererSemanticLine,
} from "./ghostty-renderer-probe";

export interface TerminalDimensions {
	cols: number;
	rows: number;
	scrollback: number;
}

export interface TerminalOutputEvent {
	type: "output";
	encoding?: "utf8" | "base64";
	data: string;
}

export interface TerminalResizeEvent {
	type: "resize";
	cols: number;
	rows: number;
}

export type TerminalCaptureEvent = TerminalOutputEvent | TerminalResizeEvent;

export interface TerminalCaptureFixture {
	fixtureVersion: 1;
	name: string;
	source: "synthetic" | "captured";
	initial: TerminalDimensions;
	events: TerminalCaptureEvent[];
	expected: Partial<TerminalSemanticState>;
	expectedCells?: Array<{
		row: number;
		col: number;
		cell: RendererSemanticCell;
	}>;
	afterReplay?: TerminalCaptureEvent[];
	expectedAfterReplay?: Partial<TerminalSemanticState>;
	provenance?: {
		command: string;
		platform: string;
		capturedAt: string;
	};
}

export interface TerminalModeState {
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

export interface TerminalCursorState {
	visible: boolean;
	style: "block" | "underline" | "bar";
	blink: boolean;
}

export interface TerminalSemanticState {
	activeBuffer: "normal" | "alternate";
	title: string;
	unicodeVersion: "ghostty-vt";
	dimensions: {
		cols: number;
		rows: number;
	};
	cursor: TerminalCursorState & {
		x: number;
		y: number;
	};
	modes: TerminalModeState;
	screen: RendererSemanticLine[];
	scrollback: RendererSemanticLine[];
}

export interface TerminalSnapshotOutputEvent {
	type: "output";
	encoding: "utf8" | "base64";
	data: string;
}

export interface TerminalSnapshotResizeEvent {
	type: "resize";
	cols: number;
	rows: number;
}

export type TerminalSnapshotEvent = TerminalSnapshotOutputEvent | TerminalSnapshotResizeEvent;

export interface TerminalSnapshotV1 {
	format: "dev3-terminal-state-spike";
	version: 1;
	strategy: "event-journal";
	parser: typeof GHOSTTY_PARSER_ID;
	initial: TerminalDimensions;
	events: TerminalSnapshotEvent[];
}

const SNAPSHOT_FORMAT = "dev3-terminal-state-spike";

class TerminalMetadataTracker {
	readonly cursor: TerminalCursorState = {
		visible: true,
		style: "block",
		blink: false,
	};
	title = "";
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
				} else {
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

function encodeOutput(data: string | Uint8Array): TerminalSnapshotOutputEvent {
	return typeof data === "string"
		? { type: "output", encoding: "utf8", data }
		: { type: "output", encoding: "base64", data: Buffer.from(data).toString("base64") };
}

function decodeOutput(event: TerminalSnapshotOutputEvent): string | Uint8Array {
	return event.encoding === "utf8" ? event.data : Uint8Array.from(Buffer.from(event.data, "base64"));
}

export function decodeCaptureOutput(event: TerminalOutputEvent): string | Uint8Array {
	return event.encoding === "base64"
		? Uint8Array.from(Buffer.from(event.data, "base64"))
		: event.data;
}

export class HeadlessTerminalState {
	private readonly events: TerminalSnapshotEvent[] = [];
	private readonly metadata = new TerminalMetadataTracker();

	private constructor(
		private readonly initial: TerminalDimensions,
		private readonly parser: GhosttyRendererProbe,
	) {}

	static async create(options: TerminalDimensions): Promise<HeadlessTerminalState> {
		return new HeadlessTerminalState({ ...options }, await GhosttyRendererProbe.create(options));
	}

	async ingest(data: string | Uint8Array): Promise<void> {
		this.parser.ingest(data);
		this.metadata.ingest(data);
		this.events.push(encodeOutput(data));
	}

	resize(cols: number, rows: number): void {
		this.parser.resize(cols, rows);
		this.events.push({ type: "resize", cols, rows });
	}

	inspect(): TerminalSemanticState {
		const state = this.parser.inspect();
		return {
			...state,
			title: this.metadata.title,
			unicodeVersion: "ghostty-vt",
			cursor: {
				x: state.cursor.x,
				y: state.cursor.y,
				...this.metadata.cursor,
			},
		};
	}

	snapshot(): TerminalSnapshotV1 {
		return {
			format: SNAPSHOT_FORMAT,
			version: 1,
			strategy: "event-journal",
			parser: GHOSTTY_PARSER_ID,
			initial: { ...this.initial },
			events: this.events.map((event) => ({ ...event })),
		};
	}

	dispose(): void {
		this.parser.dispose();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isDimensions(value: unknown): value is TerminalDimensions {
	return (
		isRecord(value) &&
		Number.isInteger(value.cols) &&
		Number(value.cols) > 0 &&
		Number.isInteger(value.rows) &&
		Number(value.rows) > 0 &&
		Number.isInteger(value.scrollback) &&
		Number(value.scrollback) >= 0
	);
}

function isSnapshotEvent(value: unknown): value is TerminalSnapshotEvent {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "resize") {
		return (
			Number.isInteger(value.cols) &&
			Number(value.cols) > 0 &&
			Number.isInteger(value.rows) &&
			Number(value.rows) > 0
		);
	}
	return (
		value.type === "output" &&
		(value.encoding === "utf8" || value.encoding === "base64") &&
		typeof value.data === "string"
	);
}

function isTerminalSnapshotV1(value: unknown): value is TerminalSnapshotV1 {
	return (
		isRecord(value) &&
		value.format === SNAPSHOT_FORMAT &&
		value.version === 1 &&
		value.strategy === "event-journal" &&
		value.parser === GHOSTTY_PARSER_ID &&
		isDimensions(value.initial) &&
		Array.isArray(value.events) &&
		value.events.every(isSnapshotEvent)
	);
}

export function serializeTerminalSnapshot(snapshot: TerminalSnapshotV1): string {
	return JSON.stringify(snapshot);
}

export function parseTerminalSnapshot(serialized: string): TerminalSnapshotV1 {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error("Unsupported terminal snapshot: invalid JSON");
	}
	if (!isTerminalSnapshotV1(value)) {
		throw new Error("Unsupported terminal snapshot format or version");
	}
	return value;
}

export function replaySnapshotIntoRenderer(
	snapshot: TerminalSnapshotV1,
	renderer: GhosttyRendererProbe,
): void {
	if (!isTerminalSnapshotV1(snapshot)) {
		throw new Error("Unsupported terminal snapshot format or version");
	}
	for (const event of snapshot.events) {
		if (event.type === "output") renderer.ingest(decodeOutput(event));
		else renderer.resize(event.cols, event.rows);
	}
}

export async function replayTerminalSnapshot(
	snapshot: TerminalSnapshotV1,
): Promise<HeadlessTerminalState> {
	if (!isTerminalSnapshotV1(snapshot)) {
		throw new Error("Unsupported terminal snapshot format or version");
	}
	const replay = await HeadlessTerminalState.create(snapshot.initial);
	for (const event of snapshot.events) {
		if (event.type === "output") await replay.ingest(decodeOutput(event));
		else replay.resize(event.cols, event.rows);
	}
	return replay;
}
