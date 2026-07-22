/**
 * Ordered ground-truth stream tap for live-parser PROOF runs (seq 1228).
 *
 * When `DEV3_NATIVE_SESSION_STATE_TAP=1`, the host appends every PTY output
 * chunk and resize — in exact callback order — to `stream-tap.ndjson`. A proof
 * harness replays the tap through a fresh Ghostty core up to the snapshot's
 * `watermarkSeq` and compares semantic screens, proving the deferred live
 * parser saw the same ordered stream a ground-truth replay would.
 *
 * The tap and the parser queue count sequence numbers in lockstep because both
 * are fed from the same callback/control-frame sites in the same order; the
 * E2E asserts the watermark maps onto tap entries exactly.
 *
 * Deliberately UNBOUNDED and therefore evidence-only: never enabled by default,
 * never part of the bounded journal/state path, removed with the session state.
 * Agent-target taps may hold real transcripts — matrix runs keep them in the
 * local raw directory and never publish them (WINDOWS-MATRIX privacy policy).
 */

import { appendFileSync, readFileSync } from "node:fs";
import { streamTapFile } from "./paths";

export interface TapOutputEntry {
	seq: number;
	kind: "output";
	data: string; // base64
}

export interface TapResizeEntry {
	seq: number;
	kind: "resize";
	cols: number;
	rows: number;
}

export type TapEntry = TapOutputEntry | TapResizeEntry;

export class StreamTapWriter {
	private seq = 0;
	private pending: string[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly path: string,
		private readonly flushMs: number = 150,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.flush(), this.flushMs);
		this.timer.unref?.();
	}

	/** Callback-safe: bounded work (base64 encode + array push), no I/O. */
	recordOutput(bytes: Uint8Array): void {
		this.seq++;
		if (bytes.length === 0) return;
		this.pending.push(`${JSON.stringify({ seq: this.seq, kind: "output", data: Buffer.from(bytes).toString("base64") })}\n`);
	}

	recordResize(cols: number, rows: number): void {
		this.seq++;
		this.pending.push(`${JSON.stringify({ seq: this.seq, kind: "resize", cols, rows })}\n`);
	}

	flush(): void {
		if (this.pending.length === 0) return;
		const lines = this.pending;
		this.pending = [];
		try {
			appendFileSync(this.path, lines.join(""), { mode: 0o600 });
		} catch {
			// evidence-only channel — a failed tap write must never hurt the host
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

export function parseTapLine(line: string): TapEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Record<string, unknown>;
	if (typeof entry.seq !== "number") return null;
	if (entry.kind === "output" && typeof entry.data === "string") {
		return { seq: entry.seq, kind: "output", data: entry.data };
	}
	if (entry.kind === "resize" && typeof entry.cols === "number" && typeof entry.rows === "number") {
		return { seq: entry.seq, kind: "resize", cols: entry.cols, rows: entry.rows };
	}
	return null;
}

/** All tap entries for `sessionId`, oldest first ([] when absent). */
export function readStreamTap(sessionId: string): TapEntry[] {
	try {
		const entries: TapEntry[] = [];
		for (const line of readFileSync(streamTapFile(sessionId), "utf8").split("\n")) {
			const entry = parseTapLine(line);
			if (entry) entries.push(entry);
		}
		return entries;
	} catch {
		return [];
	}
}
