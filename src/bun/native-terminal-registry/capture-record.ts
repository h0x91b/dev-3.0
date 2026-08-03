/**
 * The compact host capture projection (seq 1412, Fork 1).
 *
 * ONE bounded, atomically-written record holding everything a read-only pane
 * capture needs, and nothing else: who produced it, when it last changed, which
 * buffer is showing, the physical rows, and the producer's own health.
 *
 * It exists because the per-cell `parser-state.json` is the wrong shape for this
 * job. That file is 2.5–4.6 MiB per pane per write at 120×40, and measurement put
 * six busy panes at 21.5 MiB/s of disk churn and +1.3 GiB of resident memory —
 * cost paid entirely for colours, attributes, cursor state, and modes that a
 * capture discards. This record carries rows of text, so the same six panes write
 * kilobytes.
 *
 * Rules that keep it cheap and honest:
 *  - **Bounded before it is written.** `writeCaptureRecordAtomic` trims history
 *    oldest-first until the serialised record fits {@link CAPTURE_RECORD_MAX_BYTES},
 *    and records how many rows it dropped. A reader never has to defend itself
 *    against an unbounded file.
 *  - **Atomic.** tmp + rename, like `record.json`, so a reader never sees half a
 *    screen.
 *  - **Self-identifying.** The producer's pids and start signatures travel WITH
 *    the text, so a reader can tell that the rows it just read came from the pane
 *    it thinks it is looking at — not from its replacement.
 *  - **No cursor, no colours, no modes, no command, no environment.** A capture is
 *    text; anything else belongs to diagnostics.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { captureRecordFile, sessionDir } from "./paths";

export const CAPTURE_RECORD_SCHEMA = "dev3-native-capture-record" as const;
export const CAPTURE_RECORD_VERSION = 1 as const;

/**
 * Ceiling for the serialised record. Deliberately the same 256 KiB the product
 * capture seam enforces, so the producer can never write more than a consumer is
 * allowed to return.
 */
export const CAPTURE_RECORD_MAX_BYTES = 256 * 1024;

export type CaptureProducerHealth = "live" | "overflowed" | "failed";

/**
 * Who wrote these rows. The same evidence ownership classification uses, so a
 * reader can prove the text and the pane belong to the same incarnation.
 */
export interface CaptureProducer {
	hostPid: number;
	hostStartSignature: string;
	shellPid: number;
	shellStartSignature: string;
}

export interface CaptureRecord {
	schema: typeof CAPTURE_RECORD_SCHEMA;
	version: typeof CAPTURE_RECORD_VERSION;
	sessionId: string;
	producer: CaptureProducer;
	/** When these rows were produced — the capture's `sourceUpdatedAt`. */
	updatedAt: string;
	/** Queue sequence the producer had ingested when it built this. */
	watermarkSeq: number;
	activeBuffer: "normal" | "alternate";
	cols: number;
	rows: number;
	/** Physical rows of the visible screen, top row first. */
	viewport: string[];
	/** Physical rows that scrolled off, oldest first, ending above `viewport[0]`. */
	history: string[];
	/** Total scrollback the producer holds, so a reader can report what it lacks. */
	historyTotal: number;
	health: {
		status: CaptureProducerHealth;
		error?: string;
		droppedBytes: number;
		droppedChunks: number;
		resyncGaps: number;
	};
}

export function serializeCaptureRecord(record: CaptureRecord): string {
	return `${JSON.stringify(record)}\n`;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFiniteInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Fail-closed, like every other versioned artifact here: an unknown schema or
 * version is unreadable rather than best-effort. `sessionId` must match, so a
 * misfiled record can never be read as another pane's screen.
 */
export function parseCaptureRecord(text: string, sessionId: string): CaptureRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.schema !== CAPTURE_RECORD_SCHEMA || r.version !== CAPTURE_RECORD_VERSION) return null;
	if (r.sessionId !== sessionId) return null;
	const producer = r.producer as Record<string, unknown> | undefined;
	const health = r.health as Record<string, unknown> | undefined;
	if (
		!producer ||
		!isFiniteInt(producer.hostPid) ||
		typeof producer.hostStartSignature !== "string" ||
		!isFiniteInt(producer.shellPid) ||
		typeof producer.shellStartSignature !== "string" ||
		typeof r.updatedAt !== "string" ||
		!isFiniteInt(r.watermarkSeq) ||
		(r.activeBuffer !== "normal" && r.activeBuffer !== "alternate") ||
		!isFiniteInt(r.cols) ||
		!isFiniteInt(r.rows) ||
		!isStringArray(r.viewport) ||
		!isStringArray(r.history) ||
		!isFiniteInt(r.historyTotal) ||
		!health ||
		(health.status !== "live" && health.status !== "overflowed" && health.status !== "failed") ||
		!isFiniteInt(health.droppedBytes) ||
		!isFiniteInt(health.droppedChunks) ||
		!isFiniteInt(health.resyncGaps)
	) {
		return null;
	}
	return {
		schema: CAPTURE_RECORD_SCHEMA,
		version: CAPTURE_RECORD_VERSION,
		sessionId,
		producer: {
			hostPid: producer.hostPid,
			hostStartSignature: producer.hostStartSignature,
			shellPid: producer.shellPid,
			shellStartSignature: producer.shellStartSignature,
		},
		updatedAt: r.updatedAt,
		watermarkSeq: r.watermarkSeq,
		activeBuffer: r.activeBuffer,
		cols: r.cols,
		rows: r.rows,
		viewport: r.viewport,
		history: r.history,
		historyTotal: r.historyTotal,
		health: {
			status: health.status,
			...(typeof health.error === "string" ? { error: health.error } : {}),
			droppedBytes: health.droppedBytes,
			droppedChunks: health.droppedChunks,
			resyncGaps: health.resyncGaps,
		},
	};
}

export function readCaptureRecord(sessionId: string): CaptureRecord | null {
	try {
		return parseCaptureRecord(readFileSync(captureRecordFile(sessionId), "utf8"), sessionId);
	} catch {
		return null;
	}
}

/**
 * Trim to the byte ceiling by dropping the OLDEST history rows — the same order
 * of loss the product seam uses, so bounding twice cannot reorder anything. The
 * viewport is never dropped here: a record that cannot hold one screen is a
 * geometry problem, not something to silently halve.
 */
export function boundCaptureRecord(record: CaptureRecord): CaptureRecord {
	let bounded = record;
	while (
		bounded.history.length > 0 &&
		Buffer.byteLength(serializeCaptureRecord(bounded), "utf8") > CAPTURE_RECORD_MAX_BYTES
	) {
		// Halve the history each pass: one row at a time would re-serialise the whole
		// record thousands of times per write.
		const keep = Math.floor(bounded.history.length / 2);
		bounded = { ...bounded, history: bounded.history.slice(bounded.history.length - keep) };
	}
	return bounded;
}

export function writeCaptureRecordAtomic(record: CaptureRecord): void {
	const bounded = boundCaptureRecord(record);
	const target = captureRecordFile(record.sessionId);
	const tmp = `${target}.tmp`;
	mkdirSync(sessionDir(record.sessionId), { recursive: true });
	writeFileSync(tmp, serializeCaptureRecord(bounded), { mode: 0o600 });
	try {
		renameSync(tmp, target);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// nothing to clean up
		}
		throw err;
	}
}
