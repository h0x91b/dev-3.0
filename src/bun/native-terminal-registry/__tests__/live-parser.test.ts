import { describe, expect, it } from "vitest";
import type { GhosttyLiveOptions, LiveParserCore, NativeSemanticState } from "../ghostty-live";
import { LiveParserPipeline, type LiveParserPipelineOptions } from "../live-parser";
import type { ParserStateSnapshot } from "../parser-state";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const last = <T>(items: T[]): T | undefined => items[items.length - 1];

function emptyState(): NativeSemanticState {
	return {
		activeBuffer: "normal",
		title: "",
		dimensions: { cols: 80, rows: 24 },
		cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
		modes: {
			applicationCursorKeys: false,
			applicationKeypad: false,
			bracketedPaste: false,
			focusEvents: false,
			insert: false,
			mouseTracking: "none",
			origin: false,
			reverseWraparound: false,
			synchronizedOutput: false,
			wraparound: true,
		},
		screen: [],
		scrollback: [],
		scrollbackLength: 0,
	};
}

class FakeCore implements LiveParserCore {
	readonly applied: string[] = [];
	ingestError: Error | null = null;
	inspectError: Error | null = null;
	disposed = false;
	private pendingResponses: string[] = [];

	ingest(data: Uint8Array): void {
		if (this.ingestError) throw this.ingestError;
		const text = decoder.decode(data);
		this.applied.push(`output:${text}`);
		// Model Ghostty answering a cursor-position query with exactly one reply.
		let index = text.indexOf("\x1b[6n");
		while (index >= 0) {
			this.pendingResponses.push("\x1b[5;7R");
			index = text.indexOf("\x1b[6n", index + 1);
		}
	}

	resize(cols: number, rows: number): void {
		this.applied.push(`resize:${cols}x${rows}`);
	}

	readResponses(): string[] {
		return this.pendingResponses.splice(0, this.pendingResponses.length);
	}

	inspect(): NativeSemanticState {
		if (this.inspectError) throw this.inspectError;
		return emptyState();
	}

	dispose(): void {
		this.disposed = true;
	}
}

interface Harness {
	pipeline: LiveParserPipeline;
	core: FakeCore;
	replies: string[];
	snapshots: ParserStateSnapshot[];
	runScheduled: () => void;
}

async function makeHarness(overrides: Partial<LiveParserPipelineOptions> = {}): Promise<Harness> {
	const core = new FakeCore();
	const replies: string[] = [];
	const snapshots: ParserStateSnapshot[] = [];
	const tasks: Array<() => void> = [];
	const pipeline = await LiveParserPipeline.create({
		sessionId: "s1",
		cols: 80,
		rows: 24,
		writeReply: (reply) => replies.push(reply),
		persistState: (snapshot) => snapshots.push(snapshot),
		createCore: (_options: GhosttyLiveOptions) => Promise.resolve(core),
		schedule: (fn) => tasks.push(fn),
		memory: () => ({ rssBytes: 1, heapUsedBytes: 1 }),
		...overrides,
	});
	return {
		pipeline,
		core,
		replies,
		snapshots,
		runScheduled: () => {
			while (tasks.length > 0) tasks.shift()?.();
		},
	};
}

describe("LiveParserPipeline", () => {
	it("never parses inside the callback — ingestion happens only on the scheduled drain", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("hello"));
		expect(h.core.applied).toEqual([]); // callback did only bounded enqueueing
		h.runScheduled();
		expect(h.core.applied).toEqual(["output:hello"]);
	});

	it("applies output and resize events in their original order", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("a"));
		h.pipeline.onResize(120, 40);
		h.pipeline.onOutput(encoder.encode("b"));
		h.runScheduled();
		expect(h.core.applied).toEqual(["output:a", "resize:120x40", "output:b"]);
	});

	it("writes exactly one reply per query back to the PTY, and a reply echo produces no loop", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("\x1b[6n"));
		h.runScheduled();
		expect(h.replies).toEqual(["\x1b[5;7R"]);
		// The shell echoing the reply back as output must not generate another reply.
		h.pipeline.onOutput(encoder.encode("\x1b[5;7R"));
		h.runScheduled();
		expect(h.replies).toHaveLength(1);
		expect(h.pipeline.snapshot().ingested.replies).toBe(1);
	});

	it("caps replies per drain", async () => {
		const h = await makeHarness({ maxRepliesPerDrain: 2 });
		h.pipeline.onOutput(encoder.encode("\x1b[6n\x1b[6n\x1b[6n"));
		h.runScheduled();
		expect(h.replies).toHaveLength(2);
	});

	it("contains a parser failure: failed verdict persisted, host-facing calls never throw", async () => {
		const h = await makeHarness();
		h.core.ingestError = new Error("boom");
		h.pipeline.onOutput(encoder.encode("x"));
		expect(() => h.runScheduled()).not.toThrow();
		expect(h.pipeline.healthStatus).toBe("failed");
		expect(last(h.snapshots)?.health.status).toBe("failed");
		expect(last(h.snapshots)?.health.error).toContain("boom");
		// Further callback traffic is a bounded no-op.
		h.pipeline.onOutput(encoder.encode("y"));
		h.runScheduled();
		expect(h.core.applied).toEqual([]);
	});

	it("reports the injected fault exactly like a real parser failure", async () => {
		const h = await makeHarness({ fault: "ingest" });
		h.pipeline.onOutput(encoder.encode("x"));
		h.runScheduled();
		expect(h.pipeline.healthStatus).toBe("failed");
		expect(last(h.snapshots)?.health.error).toContain("injected parser fault");
	});

	it("flips to an explicit overflowed verdict when the queue cap is exceeded", async () => {
		const h = await makeHarness({ queueMaxBytes: 4 });
		h.pipeline.onOutput(encoder.encode("1234"));
		h.pipeline.onOutput(encoder.encode("56")); // dropped — over the cap
		h.runScheduled();
		expect(h.pipeline.healthStatus).toBe("overflowed");
		const verdict = last(h.snapshots);
		expect(verdict?.health.status).toBe("overflowed");
		expect(verdict?.health.overflow.droppedChunks).toBe(1);
		expect(verdict?.health.overflow.droppedBytes).toBe(2);
		// Sustained flood after the verdict costs nothing and stays silent-safe.
		h.pipeline.onOutput(encoder.encode("flood"));
		h.runScheduled();
		expect(last(h.snapshots)).toBe(verdict);
	});

	it("flush() force-drains pending events and persists with the watermark", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("tail"));
		h.pipeline.flush(); // no scheduled task ran — flush must drain by itself
		expect(h.core.applied).toEqual(["output:tail"]);
		const flushed = last(h.snapshots);
		expect(flushed?.watermarkSeq).toBe(1);
		expect(flushed?.ingested.frames).toBe(1);
		expect(flushed?.health.status).toBe("live");
	});

	it("records drain latency statistics", async () => {
		let tick = 0;
		const h = await makeHarness({ now: () => (tick += 5) });
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.pipeline.onOutput(encoder.encode("b"));
		h.runScheduled();
		const snapshot = h.pipeline.snapshot();
		expect(snapshot.latency.drains).toBe(2);
		expect(snapshot.latency.totalMs).toBe(10);
		expect(snapshot.latency.maxMs).toBe(5);
		expect(snapshot.latency.p50Ms).toBe(5);
		expect(snapshot.latency.p95Ms).toBe(5);
	});

	it("keeps the parser healthy when writing a reply throws (PTY already closed)", async () => {
		const h = await makeHarness({
			writeReply: () => {
				throw new Error("terminal closed");
			},
		});
		h.pipeline.onOutput(encoder.encode("\x1b[6n"));
		expect(() => h.runScheduled()).not.toThrow();
		expect(h.pipeline.healthStatus).toBe("live");
	});

	it("degrades to failed when inspection breaks, without throwing from snapshot()", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.core.inspectError = new Error("inspect broke");
		const snapshot = h.pipeline.snapshot();
		expect(snapshot.health.status).toBe("failed");
		expect(snapshot.state).toBeNull();
	});

	it("dispose() frees the core and further traffic is ignored", async () => {
		const h = await makeHarness();
		h.pipeline.dispose();
		expect(h.core.disposed).toBe(true);
		h.pipeline.onOutput(encoder.encode("late"));
		h.runScheduled();
		expect(h.core.applied).toEqual([]);
	});
});
