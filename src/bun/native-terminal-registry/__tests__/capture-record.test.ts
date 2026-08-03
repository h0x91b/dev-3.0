/**
 * The compact plain-text capture record: bounding, atomicity, and
 * fail-closed parsing. These are the properties that let a reader trust one file
 * read without defending itself.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NATIVE_SESSIONS_DIR_ENV, captureRecordFile, sessionDir } from "../paths";
import {
	CAPTURE_RECORD_MAX_BYTES,
	CAPTURE_RECORD_SCHEMA,
	CAPTURE_RECORD_VERSION,
	captureRecordOf,
	inspectCaptureRecord,
	inspectCaptureRecordText,
	readCaptureRecord,
	serializeCaptureRecord,
	captureContentIdentity,
	captureProducerDigest,
	writeCaptureRecordAtomic,
	type CaptureRecord,
} from "../capture-record";
import { InvalidProducerDigestError, asProducerDigest } from "../capture-digest";

/** The parsed record, or null when the text is not believable. */
function recordOrNull(record: CaptureRecord, sessionId: string): CaptureRecord | null {
	const inspection = inspectCaptureRecordText(serializeCaptureRecord(record), sessionId);
	return inspection.kind === "present" ? inspection.record : null;
}

function sample(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
	return {
		schema: CAPTURE_RECORD_SCHEMA,
		version: CAPTURE_RECORD_VERSION,
		sessionId: "alpha",
		producer: {
			hostPid: 4242,
			hostStartSignature: "h-4242",
			shellPid: 4243,
			shellStartSignature: "s-4243",
		},
		updatedAt: "2026-08-03T10:00:00.000Z",
		watermarkSeq: 7,
		activeBuffer: "normal",
		cols: 120,
		rows: 40,
		viewport: ["row-a", "row-b"],
		history: ["old-a", "old-b"],
		historyTotal: 2,
		viewportRowsOmitted: 0,
		health: { status: "live", droppedBytes: 0, droppedChunks: 0, resyncGaps: 0 },
		...overrides,
	};
}

describe("capture record — shape and parsing", () => {
	it("round-trips a live record", () => {
		expect(recordOrNull(sample(), "alpha")).toEqual(sample());
	});

	it("carries the producer's identity with the text", () => {
		// This is what lets a reader prove the rows came from the pane it means.
		const parsed = recordOrNull(sample(), "alpha");
		expect(parsed?.producer).toEqual({
			hostPid: 4242,
			hostStartSignature: "h-4242",
			shellPid: 4243,
			shellStartSignature: "s-4243",
		});
	});

	it("carries no colours, cursor, modes, command, or environment", () => {
		const text = serializeCaptureRecord(sample());
		for (const forbidden of ["foreground", "background", "cursor", "modes", "command", "env"]) {
			expect(text).not.toContain(forbidden);
		}
	});

	it("is fail-closed on schema, version, and session identity", () => {
		expect(recordOrNull(sample(), "beta")).toBeNull();
		const broken: Array<Partial<CaptureRecord>> = [
			{ schema: "something-else" as never },
			{ version: 2 as never },
			{ activeBuffer: "sixel" as never },
			{ viewport: [1, 2] as never },
			{ history: "not-an-array" as never },
			{ health: { status: "wat", droppedBytes: 0, droppedChunks: 0, resyncGaps: 0 } as never },
			{ producer: { hostPid: 1, hostStartSignature: "h" } as never },
		];
		for (const overrides of broken) {
			expect(recordOrNull(sample(overrides), "alpha")).toBeNull();
		}
		expect(inspectCaptureRecordText("not json", "alpha").kind === "present" ? {} : null).toBeNull();
	});

	it("keeps a parser failure's reason but not its absence", () => {
		const failed = sample({ health: { status: "failed", error: "boom", droppedBytes: 5, droppedChunks: 1, resyncGaps: 2 } });
		const parsed = recordOrNull(failed, "alpha");
		expect(parsed?.health).toEqual({ status: "failed", error: "boom", droppedBytes: 5, droppedChunks: 1, resyncGaps: 2 });
		expect(recordOrNull(sample(), "alpha")?.health).not.toHaveProperty("error");
	});
});

describe("capture record — bounding", () => {
	const projection = (viewport: string[], history: string[], historyTotal = history.length) => ({
		watermarkSeq: 1,
		activeBuffer: "normal" as const,
		cols: 120,
		rows: 40,
		viewport,
		history,
		historyTotal,
		status: "live" as const,
		droppedBytes: 0,
		droppedChunks: 0,
		resyncGaps: 0,
	});

	it("stays under the ceiling by dropping the OLDEST history rows", () => {
		const row = "x".repeat(200);
		const history = Array.from({ length: 5000 }, (_, i) => `${i}-${row}`);
		const record = captureRecordOf("alpha", sample().producer, projection(["screen"], history, 5000));
		expect(Buffer.byteLength(serializeCaptureRecord(record), "utf8")).toBeLessThanOrEqual(CAPTURE_RECORD_MAX_BYTES);
		// The newest rows survive; the total depth is still reported honestly.
		expect(record.history[record.history.length - 1]).toBe(history[history.length - 1]);
		expect(record.history.length).toBeLessThan(history.length);
		expect(record.historyTotal).toBe(5000);
		expect(record.viewport).toEqual(["screen"]);
		expect(record.viewportRowsOmitted).toBe(0);
	});

	it("trims the viewport only as a last resort, and says how much", () => {
		// One absurd screen with no history at all: the budget can only come from rows.
		const rows = Array.from({ length: 400 }, (_, i) => `${i}-${"y".repeat(2000)}`);
		const record = captureRecordOf("alpha", sample().producer, projection(rows, []));
		expect(Buffer.byteLength(serializeCaptureRecord(record), "utf8")).toBeLessThanOrEqual(CAPTURE_RECORD_MAX_BYTES);
		expect(record.history).toEqual([]);
		expect(record.viewportRowsOmitted).toBeGreaterThan(0);
		// The NEWEST rows are the ones kept.
		expect(record.viewport[record.viewport.length - 1]).toBe(rows[rows.length - 1]);
	});

	it("never splits a row or a code point, even one row over the whole budget", () => {
		const monster = "\u65e5".repeat(CAPTURE_RECORD_MAX_BYTES); // 3 bytes per character
		const record = captureRecordOf("alpha", sample().producer, projection([monster], []));
		expect(Buffer.byteLength(serializeCaptureRecord(record), "utf8")).toBeLessThanOrEqual(CAPTURE_RECORD_MAX_BYTES);
		expect(record.viewport).toEqual([]);
		expect(record.viewportRowsOmitted).toBe(1);
	});

	it("measures UTF-8 bytes, so multibyte rows are bounded by what they cost", () => {
		const wide = Array.from({ length: 5000 }, () => "\u65e5".repeat(100));
		const record = captureRecordOf("alpha", sample().producer, projection(["screen"], wide, 5000));
		expect(Buffer.byteLength(serializeCaptureRecord(record), "utf8")).toBeLessThanOrEqual(CAPTURE_RECORD_MAX_BYTES);
		for (const row of record.history) expect(row).toHaveLength(100);
	});

	it("leaves a record that already fits completely alone", () => {
		const record = captureRecordOf("alpha", sample().producer, projection(["a", "b"], ["h"]), sample().updatedAt);
		expect(record.viewport).toEqual(["a", "b"]);
		expect(record.history).toEqual(["h"]);
		expect(record.viewportRowsOmitted).toBe(0);
	});
});

describe("capture record — on disk", () => {
	let root = "";
	const digest = () => captureProducerDigest(sample().producer);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-capture-record-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = root;
	});

	afterEach(() => {
		delete process.env[NATIVE_SESSIONS_DIR_ENV];
		rmSync(root, { recursive: true, force: true });
	});

	it("publishes to a producer-scoped path and leaves no temp behind", () => {
		writeCaptureRecordAtomic(sample());
		expect(existsSync(`${captureRecordFile("alpha", digest())}.tmp`)).toBe(false);
		expect(readCaptureRecord("alpha", digest())).toEqual(sample());
	});

	it("cannot overwrite another producer's artifact, however late its write lands", () => {
		const older = { hostPid: 1001, hostStartSignature: "h-old", shellPid: 1002, shellStartSignature: "s-old" };
		const newer = { hostPid: 2001, hostStartSignature: "h-new", shellPid: 2002, shellStartSignature: "s-new" };
		writeCaptureRecordAtomic(sample({ producer: newer, viewport: ["successor-rows"] }));
		// The stale producer publishes AFTER its successor. There is no shared name to
		// race for, so there is no ownership check left to get wrong.
		writeCaptureRecordAtomic(sample({ producer: older, viewport: ["stale-rows"] }));
		expect(readCaptureRecord("alpha", captureProducerDigest(newer))?.viewport).toEqual(["successor-rows"]);
		expect(captureProducerDigest(newer)).not.toBe(captureProducerDigest(older));
	});

	it("removes its temp file when the rename fails after a COMPLETE write", () => {
		writeCaptureRecordAtomic(sample());
		const target = captureRecordFile("alpha", digest());
		const tmp = `${target}.tmp`;

		// A real failing rename: the target is a non-empty directory, so the temp file
		// is fully written and the rename is what fails — the case the earlier test
		// missed by failing at mkdir, before anything was written at all.
		rmSync(target);
		mkdirSync(target);
		writeFileSync(join(target, "occupied"), "x");
		expect(() => writeCaptureRecordAtomic(sample({ watermarkSeq: 3 }))).toThrow();
		expect(existsSync(tmp)).toBe(false);
	});

	it("rejects a digest that is not a full validated hex digest", () => {
		for (const bad of ["../../escape", "abc", "", "Z".repeat(64), `${"a".repeat(63)}!`]) {
			expect(() => asProducerDigest(bad)).toThrow(InvalidProducerDigestError);
		}
		expect(asProducerDigest("a".repeat(64))).toBe("a".repeat(64));
	});

	it("tells absent, corrupt, and oversized apart through ONE descriptor", () => {
		expect(inspectCaptureRecord("nobody", digest())).toEqual({ kind: "absent" });

		writeCaptureRecordAtomic(sample());
		const file = captureRecordFile("alpha", digest());
		writeFileSync(file, "{ truncated");
		const corrupt = inspectCaptureRecord("alpha", digest());
		expect(corrupt.kind).toBe("rejected");
		if (corrupt.kind === "rejected") expect(corrupt.problem).toContain("not valid JSON");

		writeFileSync(file, "x".repeat(CAPTURE_RECORD_MAX_BYTES + 1));
		const huge = inspectCaptureRecord("alpha", digest());
		expect(huge.kind).toBe("rejected");
		if (huge.kind === "rejected") expect(huge.problem).toContain("over the");
		expect(existsSync(sessionDir("alpha"))).toBe(true);
	});
});

describe("capture record — content identity", () => {
	it("ignores the timestamp and the producer, so a forced re-write is not a change", () => {
		const a = sample({ updatedAt: "2026-08-03T10:00:00.000Z" });
		const b = sample({ updatedAt: "2026-08-03T11:00:00.000Z" });
		expect(captureContentIdentity(a)).toBe(captureContentIdentity(b));
		const other = sample({
			producer: { hostPid: 9, hostStartSignature: "x", shellPid: 10, shellStartSignature: "y" },
		});
		expect(captureContentIdentity(other)).toBe(captureContentIdentity(a));
	});

	it("ignores the transport watermark, which advances without changing a row", () => {
		// It is not publicly observable and it moves on events that change nothing, so
		// letting it in reset the content timestamp on a quiet pane.
		expect(captureContentIdentity(sample({ watermarkSeq: 42 }))).toBe(captureContentIdentity(sample()));
	});

	it("changes for every observable field a reader can see", () => {
		const base = captureContentIdentity(sample());
		const variants: Array<Partial<CaptureRecord>> = [
			{ viewport: ["different"] },
			{ history: ["different"] },
			{ cols: 80 },
			{ rows: 24 },
			{ historyTotal: 99 },
			{ activeBuffer: "alternate" },
			{ viewportRowsOmitted: 3 },
			{ health: { status: "overflowed", droppedBytes: 0, droppedChunks: 0, resyncGaps: 0 } },
			{ health: { status: "live", droppedBytes: 5, droppedChunks: 1, resyncGaps: 0 } },
			{ health: { status: "live", droppedBytes: 0, droppedChunks: 0, resyncGaps: 7 } },
			{ health: { status: "failed", error: "boom", droppedBytes: 0, droppedChunks: 0, resyncGaps: 0 } },
		];
		for (const overrides of variants) {
			expect(captureContentIdentity(sample(overrides))).not.toBe(base);
		}
	});
});
