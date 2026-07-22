import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_PARSER_ID } from "../ghostty-live";
import {
	PARSER_STATE_SCHEMA,
	PARSER_STATE_VERSION,
	parseParserStateSnapshot,
	readParserState,
	removeParserState,
	writeParserStateAtomic,
	type ParserStateSnapshot,
} from "../parser-state";
import { parserStateFile } from "../paths";

function snapshot(): ParserStateSnapshot {
	return {
		schema: PARSER_STATE_SCHEMA,
		version: PARSER_STATE_VERSION,
		parser: LIVE_PARSER_ID,
		sessionId: "alpha",
		watermarkSeq: 7,
		health: { status: "live", overflow: { droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 } },
		ingested: { frames: 3, bytes: 42, resizes: 1, replies: 2 },
		latency: { drains: 3, totalMs: 4, maxMs: 2, p50Ms: 1, p95Ms: 2 },
		memory: { rssBytes: 100, heapUsedBytes: 50 },
		state: null,
		updatedAt: "2026-07-22T00:00:00.000Z",
	};
}

describe("parser-state snapshot", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-parser-state-"));
		process.env.DEV3_NATIVE_SESSIONS_DIR = root;
	});

	afterEach(() => {
		delete process.env.DEV3_NATIVE_SESSIONS_DIR;
		rmSync(root, { recursive: true, force: true });
	});

	it("roundtrips through the atomic write + read path", () => {
		const written = snapshot();
		writeParserStateAtomic("alpha", written);
		expect(readParserState("alpha")).toEqual(written);
		expect(readFileSync(parserStateFile("alpha"), "utf8")).toContain(PARSER_STATE_SCHEMA);
	});

	it("rejects a foreign schema fail-closed", () => {
		expect(() => parseParserStateSnapshot(JSON.stringify({ ...snapshot(), schema: "other" }))).toThrow(
			/Unsupported parser-state snapshot/,
		);
	});

	it("rejects a foreign version fail-closed", () => {
		expect(() => parseParserStateSnapshot(JSON.stringify({ ...snapshot(), version: 2 }))).toThrow(
			/Unsupported parser-state snapshot/,
		);
	});

	it("rejects a foreign parser identity fail-closed", () => {
		expect(() => parseParserStateSnapshot(JSON.stringify({ ...snapshot(), parser: "xterm@1.0.0" }))).toThrow(
			/Unsupported parser-state snapshot/,
		);
	});

	it("rejects invalid JSON and unknown health states", () => {
		expect(() => parseParserStateSnapshot("{nope")).toThrow(/invalid JSON/);
		const bad = { ...snapshot(), health: { status: "weird", overflow: { droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 } } };
		expect(() => parseParserStateSnapshot(JSON.stringify(bad))).toThrow(/Unsupported parser-state snapshot/);
	});

	it("rejects structurally partial snapshots instead of accepting them as healthy", () => {
		const partials = [
			{ ...snapshot(), health: { status: "live" } },
			{ ...snapshot(), ingested: { frames: 3 } },
			{ ...snapshot(), latency: { drains: 3 } },
			{ ...snapshot(), memory: { rssBytes: 100 } },
			{ ...snapshot(), state: {} },
		];
		for (const partial of partials) {
			expect(() => parseParserStateSnapshot(JSON.stringify(partial))).toThrow(/Unsupported parser-state snapshot/);
		}
	});

	it("rejects a valid snapshot stored under a different session id", () => {
		writeParserStateAtomic("alpha", { ...snapshot(), sessionId: "other" });
		expect(readParserState("alpha")).toBeNull();
	});

	it("readParserState returns null for a missing or corrupt file", () => {
		expect(readParserState("alpha")).toBeNull();
		writeParserStateAtomic("alpha", snapshot());
		removeParserState("alpha");
		expect(readParserState("alpha")).toBeNull();
	});
});
