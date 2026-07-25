import { describe, expect, it } from "vitest";
import { LIVE_PARSER_ID } from "../../native-terminal-registry/ghostty-live";
import { PARSER_STATE_SCHEMA, PARSER_STATE_VERSION, type ParserStateSnapshot } from "../../native-terminal-registry/parser-state";
import { peaksOf, sampleSession, type MetricSources, type SessionMetricSample } from "../metrics";

function snapshot(overrides: Partial<ParserStateSnapshot> = {}): ParserStateSnapshot {
	return {
		schema: PARSER_STATE_SCHEMA,
		version: PARSER_STATE_VERSION,
		parser: LIVE_PARSER_ID,
		sessionId: "soak-0",
		watermarkSeq: 42,
		health: { status: "live", overflow: { droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 } },
		ingested: { frames: 10, bytes: 2_048, resizes: 1, replies: 0 },
		latency: { drains: 5, totalMs: 10, maxMs: 4, p50Ms: 1, p95Ms: 3 },
		memory: { rssBytes: 123_456, heapUsedBytes: 65_536 },
		state: null,
		updatedAt: "2026-07-25T00:00:00.000Z",
		...overrides,
	};
}

function sources(state: ParserStateSnapshot | null, sizes: Record<string, number> = {}): MetricSources {
	return {
		readParserState: () => state,
		fileBytes: (path) => {
			for (const [needle, size] of Object.entries(sizes)) if (path.includes(needle)) return size;
			return 0;
		},
	};
}

describe("sampleSession", () => {
	it("maps only what the host already publishes", () => {
		const result = sampleSession("soak-0", 3, sources(snapshot(), { "journal.ndjson": 900, "parser-state.json": 700, "record.json": 500 }));
		expect(result).toMatchObject({
			sessionId: "soak-0",
			cycle: 3,
			hostRssBytes: 123_456,
			hostHeapUsedBytes: 65_536,
			journalBytes: 900,
			snapshotBytes: 700,
			recordBytes: 500,
			watermarkSeq: 42,
			parserHealth: "live",
			drainP95Ms: 3,
			ingestedFrames: 10,
			ingestedBytes: 2_048,
		});
	});

	it("reports an unpublished snapshot as unknown rather than zero memory", () => {
		const result = sampleSession("soak-0", 0, sources(null));
		expect(result.hostRssBytes).toBeNull();
		expect(result.parserHealth).toBeNull();
		expect(result.watermarkSeq).toBeNull();
		expect(result.droppedChunks).toBe(0);
	});

	it("carries queue overflow counters through unchanged", () => {
		const overflowed = snapshot({
			health: { status: "overflowed", overflow: { droppedChunks: 2, droppedBytes: 4_096, droppedResizes: 1 } },
		});
		const result = sampleSession("soak-0", 1, sources(overflowed));
		expect(result).toMatchObject({ parserHealth: "overflowed", droppedChunks: 2, droppedBytes: 4_096, droppedResizes: 1 });
	});
});

describe("peaksOf", () => {
	const base: SessionMetricSample = sampleSession("soak-0", 0, sources(snapshot()));

	it("folds an ordered series into peaks and a final state", () => {
		const peaks = peaksOf([
			{ ...base, cycle: 0, hostRssBytes: 100, journalBytes: 10, snapshotBytes: 5, drainP95Ms: 1, parserHealth: "live" },
			{ ...base, cycle: 1, hostRssBytes: 300, journalBytes: 40, snapshotBytes: 9, drainP95Ms: 7, parserHealth: "live" },
			{ ...base, cycle: 2, hostRssBytes: 200, journalBytes: 20, snapshotBytes: 7, drainP95Ms: 2, parserHealth: "live", watermarkSeq: 99 },
		]);
		expect(peaks.hostRssPeakBytes).toBe(300);
		expect(peaks.journalPeakBytes).toBe(40);
		expect(peaks.snapshotPeakBytes).toBe(9);
		expect(peaks.drainP95PeakMs).toBe(7);
		expect(peaks.watermarkSeqFinal).toBe(99);
		expect(peaks.parserHealthFinal).toBe("live");
	});

	it("survives a series with no published memory at all", () => {
		const peaks = peaksOf([{ ...base, hostRssBytes: null, drainP95Ms: null }]);
		expect(peaks.hostRssPeakBytes).toBeNull();
		expect(peaks.drainP95PeakMs).toBeNull();
		expect(peaks.journalPeakBytes).toBe(0);
	});
});
