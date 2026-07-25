import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSplitTree, serializeSplitTree, splitPane } from "../../../shared/split-tree";
import { isValidCoordinatorId, NATIVE_MULTIPANE_DIR_ENV, coordinatorRecordFile, paneSessionId } from "../paths";
import {
	listCoordinatorIds,
	NATIVE_MULTIPANE_SCHEMA_VERSION,
	parseMultipaneRecord,
	readMultipaneRecord,
	removeMultipaneRecord,
	serializeMultipaneRecord,
	writeMultipaneRecordAtomic,
	type NativeMultipaneRecord,
} from "../record";

function twoPaneRecord(coordinatorId = "mp"): NativeMultipaneRecord {
	const tree = splitPane(createSplitTree(), "pane-1", "horizontal");
	return {
		schemaVersion: NATIVE_MULTIPANE_SCHEMA_VERSION,
		coordinatorId,
		epoch: "2026-07-25T00:00:00.000Z",
		updatedAt: "2026-07-25T00:00:01.000Z",
		layout: serializeSplitTree({ ...tree, activePaneId: "pane-1", zoomedPaneId: null }),
		panes: [
			{ paneId: "pane-1", sessionId: paneSessionId(coordinatorId, "pane-1") },
			{ paneId: "pane-2", sessionId: paneSessionId(coordinatorId, "pane-2") },
		],
	};
}

describe("native multipane coordinator ids", () => {
	it("accepts short safe ids and rejects traversal or oversized ones", () => {
		expect(isValidCoordinatorId("mp-demo_1.a")).toBe(true);
		expect(isValidCoordinatorId("..")).toBe(false);
		expect(isValidCoordinatorId("a/b")).toBe(false);
		expect(isValidCoordinatorId("x".repeat(33))).toBe(false);
	});

	it("derives a valid registry session id per logical pane", () => {
		expect(paneSessionId("mp", "pane-7")).toBe("mp-pane-7");
	});
});

describe("native multipane record", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-multipane-record-"));
		process.env[NATIVE_MULTIPANE_DIR_ENV] = root;
	});

	afterEach(() => {
		delete process.env[NATIVE_MULTIPANE_DIR_ENV];
		rmSync(root, { recursive: true, force: true });
	});

	it("round-trips a valid record", () => {
		const record = twoPaneRecord();
		expect(parseMultipaneRecord(serializeMultipaneRecord(record))).toEqual(record);
	});

	it("rejects a record whose bindings disagree with its layout", () => {
		const record = twoPaneRecord();
		const mismatched = { ...record, panes: [record.panes[0]!] };
		expect(parseMultipaneRecord(serializeMultipaneRecord(mismatched))).toBeNull();
	});

	it("rejects a foreign schema version instead of migrating it", () => {
		const record = { ...twoPaneRecord(), schemaVersion: 2 };
		expect(parseMultipaneRecord(JSON.stringify(record))).toBeNull();
	});

	it("rejects duplicate pane sessions and malformed json", () => {
		const record = twoPaneRecord();
		const duplicated = { ...record, panes: [record.panes[0]!, record.panes[0]!] };
		expect(parseMultipaneRecord(JSON.stringify(duplicated))).toBeNull();
		expect(parseMultipaneRecord("{oops")).toBeNull();
	});

	it("publishes atomically and leaves no temp file behind", () => {
		const record = twoPaneRecord();
		writeMultipaneRecordAtomic(record);
		expect(readMultipaneRecord("mp")).toEqual(record);
		expect(readFileSync(coordinatorRecordFile("mp"), "utf8")).toBe(serializeMultipaneRecord(record));
		expect(existsSync(`${coordinatorRecordFile("mp")}.${process.pid}.tmp`)).toBe(false);
	});

	it("removes state only when the epoch still matches", () => {
		const record = twoPaneRecord();
		writeMultipaneRecordAtomic(record);
		expect(removeMultipaneRecord("mp", "stale-epoch")).toBe(false);
		expect(readMultipaneRecord("mp")).toEqual(record);
		expect(removeMultipaneRecord("mp", record.epoch)).toBe(true);
		expect(readMultipaneRecord("mp")).toBeNull();
	});

	it("treats removal of already-absent state as success", () => {
		expect(removeMultipaneRecord("mp", "any")).toBe(true);
		expect(removeMultipaneRecord("mp", "any")).toBe(true);
	});

	it("lists discoverable coordinator ids", () => {
		writeMultipaneRecordAtomic(twoPaneRecord("beta"));
		writeMultipaneRecordAtomic(twoPaneRecord("alpha"));
		expect(listCoordinatorIds()).toEqual(["alpha", "beta"]);
	});
});
