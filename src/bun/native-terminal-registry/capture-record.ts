/**
 * The compact plain-text capture artifact: bounded rows plus the producer's
 * identity and health, and nothing a capture discards (no cells, colours, cursor,
 * modes, command or environment).
 *
 * Bounded BEFORE it is built, written atomically under a producer-scoped temp
 * name, and only ever renamed into place by the producer that still owns the
 * session — a stale producer's delayed rename must not overwrite a live one.
 */

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
	/** Top viewport rows the byte budget cut — never silently dropped. */
	viewportRowsOmitted: number;
	health: {
		status: CaptureProducerHealth;
		error?: string;
		droppedBytes: number;
		droppedChunks: number;
		resyncGaps: number;
	};
}

/** A projection is not writable until the producer's identity exists. */
export class ProducerNotReadyError extends Error {
	constructor(readonly sessionId: string) {
		super(`capture producer identity for ${sessionId} is not initialized yet`);
		this.name = "ProducerNotReadyError";
	}
}

/** How a capture artifact reads. Absent and invalid are DIFFERENT answers. */
export type CaptureRecordInspection =
	| { kind: "present"; record: CaptureRecord }
	| { kind: "rejected"; problem: string }
	| { kind: "absent" };

export function serializeCaptureRecord(record: CaptureRecord): string {
	return `${JSON.stringify(record)}\n`;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
	return encoder.encode(value).length;
}

/**
 * Fit the rows to the byte budget in ONE pass over each list, newest first, so a
 * huge screen cannot make bounding quadratic. Every cut lands on a whole physical
 * row: no row and no code point is ever split. The viewport is trimmed only after
 * all history is gone, and then from its TOP rows so the newest output survives.
 */
function fitRows(
	viewport: readonly string[],
	history: readonly string[],
	budget: number,
): { viewport: string[]; history: string[]; viewportRowsOmitted: number } {
	const keptViewport: string[] = [];
	let used = 0;
	for (let i = viewport.length - 1; i >= 0; i--) {
		const cost = utf8Bytes(viewport[i]!) + 1;
		if (used + cost > budget) break;
		used += cost;
		keptViewport.unshift(viewport[i]!);
	}
	const keptHistory: string[] = [];
	for (let i = history.length - 1; i >= 0; i--) {
		const cost = utf8Bytes(history[i]!) + 1;
		if (used + cost > budget) break;
		used += cost;
		keptHistory.unshift(history[i]!);
	}
	return {
		viewport: keptViewport,
		history: keptHistory,
		viewportRowsOmitted: viewport.length - keptViewport.length,
	};
}

/**
 * Build the record already inside its budget. Bounding happens on the ROWS, never
 * by serialising a multi-megabyte candidate and trimming it afterwards, so an
 * absurd geometry or one enormous row costs a single pass.
 */
export function captureRecordOf(
	sessionId: string,
	producer: CaptureProducer,
	projection: {
		watermarkSeq: number;
		activeBuffer: "normal" | "alternate";
		cols: number;
		rows: number;
		viewport: string[];
		history: string[];
		historyTotal: number;
		status: CaptureProducerHealth;
		error?: string;
		droppedBytes: number;
		droppedChunks: number;
		resyncGaps: number;
	},
	updatedAt: string = new Date().toISOString(),
): CaptureRecord {
	// The envelope's own JSON costs a few hundred bytes; reserve generously rather
	// than measure it, so the result is bounded without a second serialise.
	const budget = CAPTURE_RECORD_MAX_BYTES - 4096;
	const fitted = fitRows(projection.viewport, projection.history, budget);
	return {
		schema: CAPTURE_RECORD_SCHEMA,
		version: CAPTURE_RECORD_VERSION,
		sessionId,
		producer,
		updatedAt,
		watermarkSeq: projection.watermarkSeq,
		activeBuffer: projection.activeBuffer,
		cols: projection.cols,
		rows: projection.rows,
		viewport: fitted.viewport,
		history: fitted.history,
		historyTotal: projection.historyTotal,
		viewportRowsOmitted: fitted.viewportRowsOmitted,
		health: {
			status: projection.status,
			...(projection.error ? { error: projection.error } : {}),
			droppedBytes: projection.droppedBytes,
			droppedChunks: projection.droppedChunks,
			resyncGaps: projection.resyncGaps,
		},
	};
}

/**
 * Everything a reader can OBSERVE in a record, except the timestamp and the
 * producer. Two records with the same identity say the same thing about the pane,
 * so a forced re-write of one must not claim the content just changed.
 */
export function captureContentIdentity(record: CaptureRecord): string {
	return [
		record.activeBuffer,
		record.cols,
		record.rows,
		record.historyTotal,
		record.viewportRowsOmitted,
		record.watermarkSeq,
		record.health.status,
		record.health.error ?? "",
		record.health.droppedBytes,
		record.health.droppedChunks,
		record.health.resyncGaps,
		record.viewport.join("\n"),
		record.history.join("\n"),
	].join("\u0000");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFiniteInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Fail-closed, and it says WHY. `sessionId` must match, so a misfiled record can
 * never be read as another pane's screen.
 */
export function inspectCaptureRecordText(text: string, sessionId: string): CaptureRecordInspection {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { kind: "rejected", problem: "the file is not valid JSON" };
	}
	if (!raw || typeof raw !== "object") return { kind: "rejected", problem: "the file is not a JSON object" };
	const r = raw as Record<string, unknown>;
	if (r.schema !== CAPTURE_RECORD_SCHEMA) {
		return { kind: "rejected", problem: `schema ${JSON.stringify(r.schema)} is not a capture record` };
	}
	if (r.version !== CAPTURE_RECORD_VERSION) {
		return { kind: "rejected", problem: `version ${JSON.stringify(r.version)} is not readable by this build` };
	}
	if (r.sessionId !== sessionId) {
		return { kind: "rejected", problem: `the record belongs to session ${JSON.stringify(r.sessionId)}` };
	}
	const producer = r.producer as Record<string, unknown> | undefined;
	const health = r.health as Record<string, unknown> | undefined;
	if (
		!producer ||
		!isFiniteInt(producer.hostPid) ||
		typeof producer.hostStartSignature !== "string" ||
		!isFiniteInt(producer.shellPid) ||
		typeof producer.shellStartSignature !== "string"
	) {
		return { kind: "rejected", problem: "the producer block is missing or incomplete" };
	}
	if (
		typeof r.updatedAt !== "string" ||
		!isFiniteInt(r.watermarkSeq) ||
		(r.activeBuffer !== "normal" && r.activeBuffer !== "alternate") ||
		!isFiniteInt(r.cols) ||
		!isFiniteInt(r.rows) ||
		!isStringArray(r.viewport) ||
		!isStringArray(r.history) ||
		!isFiniteInt(r.historyTotal) ||
		!isFiniteInt(r.viewportRowsOmitted) ||
		!health ||
		(health.status !== "live" && health.status !== "overflowed" && health.status !== "failed") ||
		!isFiniteInt(health.droppedBytes) ||
		!isFiniteInt(health.droppedChunks) ||
		!isFiniteInt(health.resyncGaps)
	) {
		return { kind: "rejected", problem: "a required field is missing or of the wrong type" };
	}
	return {
		kind: "present",
		record: {
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
			viewportRowsOmitted: r.viewportRowsOmitted,
			health: {
				status: health.status,
				...(typeof health.error === "string" ? { error: health.error } : {}),
				droppedBytes: health.droppedBytes,
				droppedChunks: health.droppedChunks,
				resyncGaps: health.resyncGaps,
			},
		},
	};
}

/**
 * Read with a size gate: an oversized file is rejected by its `stat`, never
 * loaded, so a runaway or hostile producer cannot make a reader allocate it.
 */
export function inspectCaptureRecord(sessionId: string): CaptureRecordInspection {
	const file = captureRecordFile(sessionId);
	let size: number;
	try {
		size = statSync(file).size;
	} catch {
		return { kind: "absent" };
	}
	if (size > CAPTURE_RECORD_MAX_BYTES) {
		return { kind: "rejected", problem: `the file is ${size} bytes, over the ${CAPTURE_RECORD_MAX_BYTES} ceiling` };
	}
	try {
		return inspectCaptureRecordText(readFileSync(file, "utf8"), sessionId);
	} catch (err) {
		return { kind: "rejected", problem: err instanceof Error ? err.message : String(err) };
	}
}

export function readCaptureRecord(sessionId: string): CaptureRecord | null {
	const inspection = inspectCaptureRecord(sessionId);
	return inspection.kind === "present" ? inspection.record : null;
}

/**
 * Publish atomically, under a producer-scoped temp name matching the registry's
 * cleanup convention, and only while this producer still owns the session. The
 * ownership re-check immediately before the rename is what stops a stale
 * producer's delayed write from overwriting its successor's rows.
 */
export function writeCaptureRecordAtomic(
	record: CaptureRecord,
	stillOwned: () => boolean = () => true,
): void {
	const target = captureRecordFile(record.sessionId);
	const tmp = `${target}.${record.producer.hostPid}.tmp`;
	mkdirSync(sessionDir(record.sessionId), { recursive: true });
	writeFileSync(tmp, serializeCaptureRecord(record), { mode: 0o600 });
	try {
		if (!stillOwned()) throw new StaleProducerError(record.sessionId);
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

/** The producer lost ownership before it could publish; its rows are dropped. */
export class StaleProducerError extends Error {
	constructor(readonly sessionId: string) {
		super(`capture record for ${sessionId} was not published: this producer no longer owns the session`);
		this.name = "StaleProducerError";
	}
}
