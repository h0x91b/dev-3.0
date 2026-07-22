/**
 * Independent, bounded per-session output journal for the native-session
 * registry (seq 1214).
 *
 * Each session owns ONE `journal.ndjson` — an append-only, byte-capped record of
 * the shell's raw output frames. It survives client disconnects, so a fresh
 * client that reattaches can replay the recent scrollback tail. Two sessions
 * keep two independent journals; neither can see the other's.
 *
 * Scope: this is a bounded byte tail, not full-fidelity terminal state / layout
 * replay (that is the terminal-state spike, explicitly out of scope here).
 *
 * The frame encode/decode and cap logic are pure so they are unit-testable; the
 * JournalWriter wraps them with buffered, debounced flushing to disk.
 */

import { renameSync, writeFileSync } from "node:fs";

export const DEFAULT_JOURNAL_MAX_BYTES = 256 * 1024;

export interface JournalFrame {
	seq: number;
	t: string;
	data: Uint8Array;
}

export function encodeJournalFrame(seq: number, isoTime: string, data: Uint8Array): string {
	const base64 = Buffer.from(data).toString("base64");
	return `${JSON.stringify({ seq, t: isoTime, data: base64 })}\n`;
}

export function parseJournalFrame(line: string): JournalFrame | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.seq !== "number" || typeof obj.t !== "string" || typeof obj.data !== "string") return null;
	return { seq: obj.seq, t: obj.t, data: new Uint8Array(Buffer.from(obj.data, "base64")) };
}

export function parseJournal(text: string): JournalFrame[] {
	const frames: JournalFrame[] = [];
	for (const line of text.split("\n")) {
		const frame = parseJournalFrame(line);
		if (frame) frames.push(frame);
	}
	return frames;
}

/**
 * Append `newLine` to a rolling buffer, dropping oldest lines until the total
 * fits `maxBytes` (always keeping the newest line even if it alone exceeds the
 * cap). Pure — the writer owns the buffer, this owns the trim policy.
 */
export function pushFrameCapped(
	frames: string[],
	bytes: number,
	newLine: string,
	maxBytes: number,
): { frames: string[]; bytes: number } {
	const next = [...frames, newLine];
	let total = bytes + Buffer.byteLength(newLine, "utf8");
	while (next.length > 1 && total > maxBytes) {
		total -= Buffer.byteLength(next[0], "utf8");
		next.shift();
	}
	return { frames: next, bytes: total };
}

/**
 * Buffered, byte-capped journal writer. Frames accumulate in memory and are
 * flushed to disk on a debounce timer and on stop, so hot output never turns
 * into one fsync per byte. The on-disk file always equals the in-memory tail.
 */
export class JournalWriter {
	private frames: string[] = [];
	private bytes = 0;
	private seq = 0;
	private dirty = false;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly path: string,
		private readonly maxBytes: number = DEFAULT_JOURNAL_MAX_BYTES,
		private readonly flushMs: number = 150,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.flush(), this.flushMs);
		this.timer.unref?.();
	}

	record(chunk: Uint8Array, isoTime: string): void {
		if (chunk.length === 0) return;
		const line = encodeJournalFrame(this.seq++, isoTime, chunk);
		const capped = pushFrameCapped(this.frames, this.bytes, line, this.maxBytes);
		this.frames = capped.frames;
		this.bytes = capped.bytes;
		this.dirty = true;
	}

	flush(): void {
		if (!this.dirty) return;
		try {
			const tmp = `${this.path}.${process.pid}.tmp`;
			writeFileSync(tmp, this.frames.join(""), { mode: 0o600 });
			renameSync(tmp, this.path);
			this.dirty = false;
		} catch (err) {
			// best-effort: a failed journal flush must never take the host down
			console.error("native-session journal flush failed:", this.path, err);
		}
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.flush();
	}
}
