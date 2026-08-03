import { describe, expect, it } from "vitest";
import type { GhosttyLiveOptions, LiveParserCore, NativeSemanticState, NativeTextProjection } from "../ghostty-live";
import { LiveParserPipeline, type LiveParserPipelineOptions } from "../live-parser";
import type { ParserStateSnapshot } from "../parser-state";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const last = <T>(items: T[]): T | undefined => items[items.length - 1];

function emptyState(title = ""): NativeSemanticState {
	return {
		activeBuffer: "normal",
		title,
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
	/** Mutating this makes the next inspected screen differ byte-wise. */
	title = "";
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
		return emptyState(this.title);
	}

	project(): NativeTextProjection {
		if (this.inspectError) throw this.inspectError;
		const state = emptyState(this.title);
		return {
			activeBuffer: state.activeBuffer,
			dimensions: state.dimensions,
			viewport: state.screen.map((line) => line.text),
			history: state.scrollback.map((line) => line.text),
			historyTotal: state.scrollbackLength,
		};
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
	/** Delays the pipeline asked for, in order — the persistence cadence evidence. */
	timerDelays: number[];
	/** Fire every armed persistence timer; returns how many fired. */
	runTimers: () => number;
}

async function makeHarness(overrides: Partial<LiveParserPipelineOptions> = {}): Promise<Harness> {
	const core = new FakeCore();
	const replies: string[] = [];
	const snapshots: ParserStateSnapshot[] = [];
	const tasks: Array<() => void> = [];
	const timerDelays: number[] = [];
	const timers = new Map<number, () => void>();
	let nextHandle = 1;
	const pipeline = await LiveParserPipeline.create({
		sessionId: "s1",
		cols: 80,
		rows: 24,
		writeReply: (reply) => replies.push(reply),
		persistState: (snapshot) => {
			snapshots.push(snapshot);
		},
		createCore: (_options: GhosttyLiveOptions) => Promise.resolve(core),
		schedule: (fn) => tasks.push(fn),
		setTimer: (fn, ms) => {
			const handle = nextHandle++;
			timers.set(handle, fn);
			timerDelays.push(ms);
			return handle;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		},
		memory: () => ({ rssBytes: 1, heapUsedBytes: 1 }),
		...overrides,
	});
	return {
		pipeline,
		core,
		replies,
		snapshots,
		timerDelays,
		runScheduled: () => {
			while (tasks.length > 0) tasks.shift()?.();
		},
		runTimers: () => {
			let fired = 0;
			while (timers.size > 0) {
				const [handle, fn] = [...timers][0];
				timers.delete(handle);
				fn();
				fired++;
				if (fired > 100) break;
			}
			return fired;
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

describe("LiveParserPipeline queue observability", () => {
	it("publishes depth, high-water, caps and pressure without exposing the events", async () => {
		const h = await makeHarness({ queueMaxBytes: 100, queueMaxEvents: 10 });
		h.pipeline.onOutput(encoder.encode("1234567890"));
		const pending = h.pipeline.queueCounters();
		expect(pending.pendingBytes).toBe(10);
		expect(pending.pendingEvents).toBe(1);
		expect(pending.maxBytes).toBe(100);
		expect(pending.maxEvents).toBe(10);
		expect(pending.pressure).toBe("nominal");
		h.runScheduled();
		const drained = h.pipeline.queueCounters();
		expect(drained.pendingBytes).toBe(0);
		// The peak survives the drain — that is the whole point of a high-water mark.
		expect(drained.highWaterBytes).toBe(10);
		expect(drained.highWaterEvents).toBe(1);
		expect(Object.keys(drained)).not.toContain("events");
	});

	it("reports slow-consumer before overflow, then the terminal overflowed verdict", async () => {
		const h = await makeHarness({ queueMaxBytes: 100, queueMaxEvents: 1_000 });
		h.pipeline.onOutput(encoder.encode("x".repeat(60))); // 60% of the byte cap
		expect(h.pipeline.queueCounters().pressure).toBe("slow-consumer");
		expect(h.pipeline.queueCounters().slowConsumerEpisodes).toBe(1);
		h.pipeline.onOutput(encoder.encode("x".repeat(60))); // dropped — over the cap
		expect(h.pipeline.queueCounters().pressure).toBe("overflowed");
		h.runScheduled();
		expect(h.pipeline.healthStatus).toBe("overflowed");
	});

	it("counts a sequence gap when an event never reaches the parser", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("a"));
		h.pipeline.onOutput(new Uint8Array(0)); // consumes a seq, is never enqueued
		h.pipeline.onOutput(encoder.encode("b"));
		h.runScheduled();
		const resync = h.pipeline.resyncCounters();
		expect(resync.gaps).toBe(1);
		expect(resync.missedSeqs).toBe(1);
		expect(resync.lastGapAtSeq).toBe(3);
	});
});

describe("LiveParserPipeline persistence budget", () => {
	it("skips a write when the semantic snapshot is byte-identical", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.runTimers();
		expect(h.snapshots).toHaveLength(1);
		expect(h.pipeline.persistenceCounters().writes).toBe(1);

		h.pipeline.onOutput(encoder.encode("b")); // more ingest, identical screen
		h.runScheduled();
		h.runTimers();
		expect(h.snapshots).toHaveLength(1);
		expect(h.pipeline.persistenceCounters().skippedIdentical).toBe(1);

		h.core.title = "changed";
		h.pipeline.onOutput(encoder.encode("c"));
		h.runScheduled();
		h.runTimers();
		expect(h.snapshots).toHaveLength(2);
		expect(h.pipeline.persistenceCounters().writes).toBe(2);
	});

	it("spaces consecutive writes by the cadence ceiling, not the debounce", async () => {
		const h = await makeHarness({ now: () => 0, persistDebounceMs: 250, persistMinIntervalMs: 1_000 });
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		expect(h.timerDelays).toEqual([250]); // nothing written yet — plain debounce
		h.runTimers();
		h.core.title = "b";
		h.pipeline.onOutput(encoder.encode("b"));
		h.runScheduled();
		expect(h.timerDelays).toEqual([250, 1_000]); // pushed out to the cadence ceiling
	});

	it("keeps at most one write in flight and coalesces dirty updates into one re-armed write", async () => {
		let release: () => void = () => {};
		const h = await makeHarness({
			persistState: () => new Promise<void>((resolve) => (release = resolve)),
		});
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.runTimers();
		expect(h.pipeline.persistenceCounters().inFlight).toBe(true);
		expect(h.pipeline.persistenceCounters().writes).toBe(1);

		// Two more dirty rounds while the write is outstanding — neither starts a write.
		for (const chunk of ["b", "c"]) {
			h.core.title = chunk;
			h.pipeline.onOutput(encoder.encode(chunk));
			h.runScheduled();
			h.runTimers();
		}
		expect(h.pipeline.persistenceCounters().writes).toBe(1);
		expect(h.pipeline.persistenceCounters().coalesced).toBe(2);

		release();
		await Promise.resolve();
		expect(h.pipeline.persistenceCounters().inFlight).toBe(false);
		h.runTimers(); // the coalesced backlog settles into exactly ONE further write
		expect(h.pipeline.persistenceCounters().writes).toBe(2);
	});

	it("flush() persists the latest state even when the semantic screen is unchanged", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.runTimers();
		expect(h.snapshots).toHaveLength(1);
		h.pipeline.onOutput(encoder.encode("b"));
		h.pipeline.flush(); // teardown must land the final counters regardless
		expect(h.snapshots).toHaveLength(2);
		expect(last(h.snapshots)?.ingested.frames).toBe(2);
	});

	it("counts a failing write, keeps the host up, and stays retryable", async () => {
		const h = await makeHarness({
			persistState: () => {
				throw new Error("disk full");
			},
		});
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		expect(() => h.runTimers()).not.toThrow();
		// A failure must NOT advance the identical-write identity: identical content
		// after a transient failure has to be written again, or one bad write silences
		// the pane forever. Draining the fake timers therefore shows repeated attempts
		// — in real time they are one per cadence interval.
		expect(h.pipeline.persistenceCounters().failures).toBeGreaterThan(1);
		expect(h.pipeline.healthStatus).toBe("live");
	});

	it("writes identical content again after a transient failure, then settles", async () => {
		let attempts = 0;
		const h = await makeHarness({
			persistState: () => {
				attempts++;
				if (attempts === 1) throw new Error("transient");
			},
		});
		h.pipeline.onOutput(encoder.encode("quiet"));
		h.runScheduled();
		h.runTimers();
		// The retry landed, so the identity finally advanced and the pane stops writing.
		expect(attempts).toBeGreaterThan(1);
		expect(h.pipeline.persistenceCounters().failures).toBe(1);
		const settled = attempts;
		h.runTimers();
		expect(attempts).toBe(settled);
	});

	it("accounts serialized snapshot bytes per write", async () => {
		const h = await makeHarness();
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.runTimers();
		const counters = h.pipeline.persistenceCounters();
		expect(counters.lastBytes).toBeGreaterThan(0);
		expect(counters.maxBytes).toBe(counters.lastBytes);
		expect(counters.totalBytes).toBe(counters.lastBytes);
		expect(counters.minIntervalMs).toBe(1_000);
	});
});

describe("LiveParserPipeline fatal lifecycle and independent sinks", () => {
	it("releases the parser core on a FATAL failure instead of holding it until teardown", async () => {
		const h = await makeHarness();
		h.core.inspectError = new Error("parser exploded");
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.runTimers();
		expect(h.pipeline.healthStatus).toBe("failed");
		// A failed parser will never produce another screen, so its WASM instance is
		// freed now rather than pinned for the life of the pane.
		expect(h.core.disposed).toBe(true);
	});

	it("keeps the core alive on overflow, whose last good screen is still the truth", async () => {
		const h = await makeHarness({ queueMaxBytes: 4 });
		h.pipeline.onOutput(encoder.encode("aaaaaaaaaaaaaaaaaaaa"));
		h.runScheduled();
		h.runTimers();
		expect(h.pipeline.healthStatus).toBe("overflowed");
		expect(h.core.disposed).toBe(false);
	});

	it("writes no further state after a fatal failure has been recorded", async () => {
		const h = await makeHarness();
		h.core.inspectError = new Error("parser exploded");
		h.pipeline.onOutput(encoder.encode("a"));
		h.runScheduled();
		h.runTimers();
		const after = h.snapshots.length;
		h.pipeline.onOutput(encoder.encode("more"));
		h.runScheduled();
		h.runTimers();
		expect(h.snapshots.length).toBe(after);
	});

	it("publishes the two sinks independently, so neither can suppress the other", async () => {
		const projections: number[] = [];
		const h = await makeHarness({ persistProjection: (p) => void projections.push(p.watermarkSeq) });
		h.pipeline.onOutput(encoder.encode("first"));
		h.runScheduled();
		h.runTimers();
		// Both sinks were wired, so both saw this change.
		expect(h.snapshots.length).toBeGreaterThan(0);
		expect(projections.length).toBeGreaterThan(0);
	});

	it("does not skip a projection whose rows are identical but whose metadata moved", async () => {
		const projections: Array<{ seq: number; cols: number }> = [];
		const h = await makeHarness({
			persistProjection: (p) => void projections.push({ seq: p.watermarkSeq, cols: p.cols }),
		});
		h.pipeline.onOutput(encoder.encode("same"));
		h.runScheduled();
		h.runTimers();
		const first = projections.length;
		// Same screen text, different geometry: a rows-only identity would call this a
		// duplicate and never publish the resize.
		h.pipeline.onResize(200, 60);
		h.runScheduled();
		h.runTimers();
		expect(projections.length).toBeGreaterThan(first);
	});
});
