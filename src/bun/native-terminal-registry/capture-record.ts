/**
 * The compact plain-text capture artifact: bounded rows plus the producer's
 * identity and health. Bounded before it is built, written under a
 * producer-scoped temp name, and renamed only by the producer that still owns it.
 */

import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
	CAPTURE_SIGNATURE_MAX,
	canonicalProducer,
	captureProducerDigest,
	type CaptureProducer,
	type CaptureProducerDigest,
} from "./capture-digest";
import { captureRecordFile, sessionDir } from "./paths";
import { withSessionStateLock } from "./session-lock";

export { captureProducerDigest, type CaptureProducer } from "./capture-digest";

export const CAPTURE_RECORD_SCHEMA = "dev3-native-capture-record" as const;
export const CAPTURE_RECORD_VERSION = 1 as const;

/**
 * Ceiling for the serialised record. Deliberately the same 256 KiB the product
 * capture seam enforces, so the producer can never write more than a consumer is
 * allowed to return.
 */
export const CAPTURE_RECORD_MAX_BYTES = 256 * 1024;

export type CaptureProducerHealth = "live" | "overflowed" | "failed";

export const CAPTURE_ERROR_MAX = 512;
/** A pane cannot legitimately be wider or taller than this, nor hold more rows. */
export const CAPTURE_GEOMETRY_MAX = 10_000;
export const CAPTURE_ROWS_MAX = 4_000;



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


/**
 * Admit rows newest-first against the EXACT serialized cost, in one pass per list.
 * JSON escapes quotes, backslashes and control characters — a row of 200 quotes is
 * 200 raw bytes and 402 serialized — so budgeting raw bytes let the producer write
 * a record its own reader then rejected as oversized. Every cut lands on a whole
 * row, and a row-count ceiling bounds the work even when rows cost nothing.
 */
function fitRowsSerialized(
	viewport: readonly string[],
	history: readonly string[],
	budget: number,
): { viewport: string[]; history: string[]; viewportRowsOmitted: number } {
	const cost = (row: string): number => Buffer.byteLength(JSON.stringify(row), "utf8") + 1; // + comma
	const admit = (rows: readonly string[], remaining: number, limit: number): { kept: string[]; used: number } => {
		const kept: string[] = [];
		let used = 0;
		for (let i = rows.length - 1; i >= 0 && kept.length < limit; i--) {
			const rowCost = cost(rows[i]!);
			if (used + rowCost > remaining) break;
			used += rowCost;
			kept.push(rows[i]!);
		}
		kept.reverse(); // built newest-first; unshifting per row would be quadratic
		return { kept, used };
	};

	// The viewport is the last thing cut, so it claims the budget first.
	const keptViewport = admit(viewport, budget, CAPTURE_ROWS_MAX);
	const keptHistory = admit(history, budget - keptViewport.used, CAPTURE_ROWS_MAX);
	return {
		viewport: keptViewport.kept,
		history: keptHistory.kept,
		viewportRowsOmitted: viewport.length - keptViewport.kept.length,
	};
}

function boundedString(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max);
}

/**
 * Build the record already inside its budget, measured on the REAL serialized
 * envelope rather than a reserved guess, with every variable string bounded.
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
	const envelope: CaptureRecord = {
		schema: CAPTURE_RECORD_SCHEMA,
		version: CAPTURE_RECORD_VERSION,
		sessionId,
		// The ONE canonical form, so the digest, the stored record and every comparison
		// agree; truncating here while the digest hashed raw strings made a valid
		// artifact unreachable.
		producer: canonicalProducer(producer),
		updatedAt,
		watermarkSeq: projection.watermarkSeq,
		activeBuffer: projection.activeBuffer,
		cols: projection.cols,
		rows: projection.rows,
		viewport: [],
		history: [],
		historyTotal: projection.historyTotal,
		viewportRowsOmitted: 0,
		health: {
			status: projection.status,
			...(projection.error ? { error: boundedString(projection.error, CAPTURE_ERROR_MAX) } : {}),
			droppedBytes: projection.droppedBytes,
			droppedChunks: projection.droppedChunks,
			resyncGaps: projection.resyncGaps,
		},
	};
	// Build, serialize, trim, recompute. The envelope's own size depends on digits
	// that are only known after trimming (viewportRowsOmitted, historyTotal), so a
	// single budget computed up front can be wrong by exactly those digits.
	let budget = CAPTURE_RECORD_MAX_BYTES - Buffer.byteLength(serializeCaptureRecord(envelope), "utf8");
	let candidate = envelope;
	for (let attempt = 0; attempt < 4; attempt++) {
		const fitted = fitRowsSerialized(projection.viewport, projection.history, Math.max(0, budget));
		candidate = {
			...envelope,
			viewport: fitted.viewport,
			history: fitted.history,
			// The producer HOLDS this much history; the record carries what fitted.
			historyTotal: Math.max(projection.historyTotal, fitted.history.length),
			viewportRowsOmitted: fitted.viewportRowsOmitted,
		};
		const actual = Buffer.byteLength(serializeCaptureRecord(candidate), "utf8");
		if (actual <= CAPTURE_RECORD_MAX_BYTES) return candidate;
		budget -= actual - CAPTURE_RECORD_MAX_BYTES;
	}
	// Fail closed rather than publish something the reader will reject as oversized.
	throw new Error(`capture record for ${sessionId} could not be bounded to ${CAPTURE_RECORD_MAX_BYTES} bytes`);
}

/**
 * Everything a reader can OBSERVE, except the timestamp and the producer. Two
 * records with the same identity say the same thing about the pane, so a forced
 * durable re-write of one must not claim the content just changed. Deliberately
 * EXCLUDES the transport watermark: it advances on events that change no row and is
 * not publicly observable, so letting it in reset the content timestamp.
 */
export function captureContentIdentity(record: CaptureRecord): string {
	return [
		record.activeBuffer,
		record.cols,
		record.rows,
		record.historyTotal,
		record.viewportRowsOmitted,
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
	// The caps are enforced, not merely declared: a type-valid but semantically
	// impossible record would otherwise be republished as KNOWN geometry and
	// truncation facts.
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
		r.cols < 1 ||
		r.rows < 1 ||
		r.cols > CAPTURE_GEOMETRY_MAX ||
		r.rows > CAPTURE_GEOMETRY_MAX ||
		producer.hostPid < 1 ||
		producer.shellPid < 1 ||
		producer.hostStartSignature.length > CAPTURE_SIGNATURE_MAX ||
		producer.shellStartSignature.length > CAPTURE_SIGNATURE_MAX ||
		(typeof health?.error === "string" && health.error.length > CAPTURE_ERROR_MAX) ||
		r.viewport.length > CAPTURE_ROWS_MAX ||
		r.history.length > CAPTURE_ROWS_MAX ||
		r.historyTotal < r.history.length ||
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
 * Read through ONE file descriptor: fstat the open object, reject on its size, then
 * read from that same descriptor into a buffer capped at the ceiling. Stat-by-path
 * followed by read-by-path let an atomic publish swap the inode between the two, so
 * the object that passed the ceiling was not the object allocated — which made the
 * bound decorative. The post-read length check covers a file that grew mid-read.
 */
export function inspectCaptureRecordAt(file: string, sessionId: string): CaptureRecordInspection {
	let fd: number;
	try {
		// No-follow and nonblocking where supported: a symlink to a FIFO at this path
		// would otherwise block the whole process before the size gate is ever reached.
		const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
		fd = openSync(file, flags);
	} catch {
		return { kind: "absent" };
	}
	try {
		const stat = fstatSync(fd);
		// Only a regular file with a single link may be read: a FIFO, a directory or a
		// hard-linked decoy is not this producer's artifact.
		if (!stat.isFile()) return { kind: "rejected", problem: "the capture path is not a regular file" };
		if (stat.nlink > 1) return { kind: "rejected", problem: `the capture path has ${stat.nlink} links` };
		if (stat.size > CAPTURE_RECORD_MAX_BYTES) {
			return { kind: "rejected", problem: `the file is ${stat.size} bytes, over the ${CAPTURE_RECORD_MAX_BYTES} ceiling` };
		}
		const buffer = Buffer.allocUnsafe(CAPTURE_RECORD_MAX_BYTES + 1);
		let read = 0;
		for (;;) {
			let chunk: number;
			try {
				chunk = readSync(fd, buffer, read, buffer.length - read, read);
			} catch (err) {
				if ((err as { code?: string }).code === "EINTR" || (err as { code?: string }).code === "EAGAIN") continue;
				throw err;
			}
			if (chunk === 0) break;
			read += chunk;
			if (read > CAPTURE_RECORD_MAX_BYTES) {
				return { kind: "rejected", problem: `the file grew past the ${CAPTURE_RECORD_MAX_BYTES} ceiling while being read` };
			}
		}
		return inspectCaptureRecordText(buffer.toString("utf8", 0, read), sessionId);
	} catch (err) {
		return { kind: "rejected", problem: err instanceof Error ? err.message : String(err) };
	} finally {
		try {
			closeSync(fd);
		} catch {
			// already closed
		}
	}
}

export function inspectCaptureRecord(
	sessionId: string,
	producerDigest: CaptureProducerDigest,
): CaptureRecordInspection {
	return inspectCaptureRecordAt(captureRecordFile(sessionId, producerDigest), sessionId);
}

export function readCaptureRecord(
	sessionId: string,
	producerDigest: CaptureProducerDigest,
): CaptureRecord | null {
	const inspection = inspectCaptureRecord(sessionId, producerDigest);
	return inspection.kind === "present" ? inspection.record : null;
}

/**
 * Publish atomically to a path only THIS producer can address. There is no
 * ownership check before the rename, because there is nothing to race for: a stale
 * producer's delayed write lands on its own dead artifact, never on its successor's.
 * The temp file is removed on every exit, including a failed or partial write.
 */
export function writeCaptureRecordAtomic(record: CaptureRecord): void {
	const target = captureRecordFile(record.sessionId, captureProducerDigest(record.producer));
	const tmp = `${target}.tmp`;
	mkdirSync(sessionDir(record.sessionId), { recursive: true });
	// Under the session lock, so a concurrent cleanup cannot delete this artifact
	// between its own enumeration and this rename.
	withSessionStateLock(record.sessionId, () => {
		try {
			writeFileSync(tmp, serializeCaptureRecord(record), { mode: 0o600 });
			renameSync(tmp, target);
		} finally {
			try {
				unlinkSync(tmp);
			} catch {
				// renamed away on success, or never created on an early failure
			}
		}
	});
}

