/**
 * The compact plain-text capture record (seq 1412): bounding, atomicity, and
 * fail-closed parsing. These are the properties that let a reader trust one file
 * read without defending itself.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NATIVE_SESSIONS_DIR_ENV, captureRecordFile, sessionDir } from "../paths";
import {
	CAPTURE_RECORD_MAX_BYTES,
	CAPTURE_RECORD_SCHEMA,
	CAPTURE_RECORD_VERSION,
	boundCaptureRecord,
	parseCaptureRecord,
	readCaptureRecord,
	serializeCaptureRecord,
	writeCaptureRecordAtomic,
	type CaptureRecord,
} from "../capture-record";

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
		health: { status: "live", droppedBytes: 0, droppedChunks: 0, resyncGaps: 0 },
		...overrides,
	};
}

describe("capture record — shape and parsing", () => {
	it("round-trips a live record", () => {
		expect(parseCaptureRecord(serializeCaptureRecord(sample()), "alpha")).toEqual(sample());
	});

	it("carries the producer's identity with the text", () => {
		// This is what lets a reader prove the rows came from the pane it means.
		const parsed = parseCaptureRecord(serializeCaptureRecord(sample()), "alpha");
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
		expect(parseCaptureRecord(serializeCaptureRecord(sample()), "beta")).toBeNull();
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
			expect(parseCaptureRecord(serializeCaptureRecord(sample(overrides)), "alpha")).toBeNull();
		}
		expect(parseCaptureRecord("not json", "alpha")).toBeNull();
	});

	it("keeps a parser failure's reason but not its absence", () => {
		const failed = sample({ health: { status: "failed", error: "boom", droppedBytes: 5, droppedChunks: 1, resyncGaps: 2 } });
		const parsed = parseCaptureRecord(serializeCaptureRecord(failed), "alpha");
		expect(parsed?.health).toEqual({ status: "failed", error: "boom", droppedBytes: 5, droppedChunks: 1, resyncGaps: 2 });
		expect(parseCaptureRecord(serializeCaptureRecord(sample()), "alpha")?.health).not.toHaveProperty("error");
	});
});

describe("capture record — bounding", () => {
	it("stays under the ceiling by dropping the OLDEST history rows", () => {
		const row = "x".repeat(200);
		const huge = sample({ history: Array.from({ length: 5000 }, (_, i) => `${i}-${row}`), historyTotal: 5000 });
		const bounded = boundCaptureRecord(huge);
		expect(Buffer.byteLength(serializeCaptureRecord(bounded), "utf8")).toBeLessThanOrEqual(CAPTURE_RECORD_MAX_BYTES);
		// The newest rows survive; the total depth is still reported honestly.
		expect(bounded.history[bounded.history.length - 1]).toBe(huge.history[huge.history.length - 1]);
		expect(bounded.history.length).toBeLessThan(huge.history.length);
		expect(bounded.historyTotal).toBe(5000);
	});

	it("never touches the viewport", () => {
		const row = "y".repeat(200);
		const huge = sample({ history: Array.from({ length: 5000 }, () => row), viewport: ["keep-me", "and-me"] });
		expect(boundCaptureRecord(huge).viewport).toEqual(["keep-me", "and-me"]);
	});

	it("leaves a record that already fits completely alone", () => {
		expect(boundCaptureRecord(sample())).toEqual(sample());
	});
});

describe("capture record — on disk", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-capture-record-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = root;
	});

	afterEach(() => {
		delete process.env[NATIVE_SESSIONS_DIR_ENV];
		rmSync(root, { recursive: true, force: true });
	});

	it("writes atomically and reads back", () => {
		writeCaptureRecordAtomic(sample());
		expect(existsSync(`${captureRecordFile("alpha")}.tmp`)).toBe(false);
		expect(readCaptureRecord("alpha")).toEqual(sample());
	});

	it("bounds on the way to disk, not only in memory", () => {
		const row = "z".repeat(300);
		writeCaptureRecordAtomic(sample({ history: Array.from({ length: 4000 }, () => row), historyTotal: 4000 }));
		expect(readFileSync(captureRecordFile("alpha"), "utf8").length).toBeLessThanOrEqual(CAPTURE_RECORD_MAX_BYTES + 1);
		expect(readCaptureRecord("alpha")?.historyTotal).toBe(4000);
	});

	it("reads a missing or corrupt file as absent rather than throwing", () => {
		expect(readCaptureRecord("nobody")).toBeNull();
		writeCaptureRecordAtomic(sample());
		writeFileSync(captureRecordFile("alpha"), "{ truncated");
		expect(readCaptureRecord("alpha")).toBeNull();
		expect(existsSync(sessionDir("alpha"))).toBe(true);
	});
});
