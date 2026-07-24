import { describe, expect, it } from "vitest";
import {
	DEFAULT_PARSER_QUEUE_MAX_BYTES,
	DEFAULT_PARSER_QUEUE_MAX_EVENTS,
	ParserEventQueue,
} from "../../parser-queue";
import { DEFAULT_JOURNAL_MAX_BYTES } from "../../journal";
import { DEFAULT_SNAPSHOT_SCROLLBACK_CAP } from "../../live-parser";
import { parseParserStateSnapshot } from "../../parser-state";
import { SteppingClock, DeterministicScheduler } from "../clock";
import { mulberry32 } from "../prng";
import {
	burstFrames,
	DSR_QUERY,
	steadyChunk,
	steadyFrames,
	totalOutputBytes,
	totalOutputFrames,
	type HarnessFrame,
} from "../generators";
import { aggregate, StreamHarness, type StreamHarnessOptions } from "../harness";
import { emptyJournal, planResync, recordJournalFrame } from "../resync";

const STREAM_COUNTS = [1, 6, 20] as const;

async function makeStream(overrides: Partial<StreamHarnessOptions> = {}): Promise<StreamHarness> {
	return StreamHarness.create({
		streamId: overrides.streamId ?? "s1",
		clock: overrides.clock ?? new SteppingClock(1),
		scheduler: overrides.scheduler ?? new DeterministicScheduler(),
		...overrides,
	});
}

/** Build N independent streams, each with its own clock + scheduler (no shared actor state). */
async function makeFleet(count: number, opts: Partial<StreamHarnessOptions> = {}): Promise<StreamHarness[]> {
	const streams: StreamHarness[] = [];
	for (let i = 0; i < count; i++) {
		streams.push(
			await StreamHarness.create({
				streamId: `stream-${i}`,
				clock: new SteppingClock(1),
				scheduler: new DeterministicScheduler(),
				...opts,
			}),
		);
	}
	return streams;
}

describe("deterministic primitives", () => {
	it("reproduces the exact same byte stream for a given seed", () => {
		const a = steadyChunk(mulberry32(42), 32);
		const b = steadyChunk(mulberry32(42), 32);
		expect(Array.from(a)).toEqual(Array.from(b));
		expect(Array.from(steadyChunk(mulberry32(43), 32))).not.toEqual(Array.from(a));
	});

	it("generators report their own byte and frame totals", () => {
		const frames = steadyFrames(mulberry32(1), { frames: 10, bytesPerFrame: 64 });
		expect(totalOutputFrames(frames)).toBe(10);
		expect(totalOutputBytes(frames)).toBe(640);
	});

	it("stepping clock advances a fixed step per read, pinning drain latency", () => {
		const clock = new SteppingClock(5, 0);
		expect(clock.now()).toBe(0);
		expect(clock.now()).toBe(5);
		expect(clock.now()).toBe(10);
	});

	it("scheduler runs pending tasks only when asked", () => {
		const scheduler = new DeterministicScheduler();
		let ran = 0;
		scheduler.schedule(() => ran++);
		scheduler.schedule(() => ran++);
		expect(scheduler.pending).toBe(2);
		expect(scheduler.runAll()).toBe(2);
		expect(ran).toBe(2);
	});
});

describe("steady output", () => {
	it.each(STREAM_COUNTS)("drains one frame at a time across %i stream(s)", async (count) => {
		const streams = await makeFleet(count);
		const perStreamFrames = 40;
		const bytesPerFrame = 128;
		streams.forEach((stream, index) => {
			const frames = steadyFrames(mulberry32(100 + index), { frames: perStreamFrames, bytesPerFrame });
			for (const frame of frames) {
				stream.feed(frame);
				stream.drain();
			}
		});
		const budgets = streams.map((s) => s.budget());
		for (const budget of budgets) {
			expect(budget.frames).toBe(perStreamFrames);
			expect(budget.bytes).toBe(perStreamFrames * bytesPerFrame);
			expect(budget.drains).toBe(perStreamFrames); // one drain iteration per frame
			expect(budget.watermarkSeq).toBe(perStreamFrames);
			expect(budget.queueHighWaterBytes).toBe(bytesPerFrame); // never backs up
			expect(budget.queueHighWaterEvents).toBe(1);
			expect(budget.health).toBe("live");
			expect(budget.overflow).toEqual({ droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 });
		}
		const rollup = aggregate(count, budgets);
		expect(rollup.totalFrames).toBe(count * perStreamFrames);
		expect(rollup.totalBytes).toBe(count * perStreamFrames * bytesPerFrame);
		streams.forEach((s) => s.dispose());
	});
});

describe("burst output", () => {
	it.each(STREAM_COUNTS)("peaks the queue on a burst then recovers across %i stream(s)", async (count) => {
		const streams = await makeFleet(count);
		const shape = { cycles: 4, quietFrames: 2, quietBytes: 64, burstFrames: 8, burstBytes: 512 };
		const cycleBytes = shape.quietFrames * shape.quietBytes + shape.burstFrames * shape.burstBytes;
		streams.forEach((stream, index) => {
			const rng = mulberry32(200 + index);
			for (let c = 0; c < shape.cycles; c++) {
				const cycle = burstFrames(rng, { ...shape, cycles: 1 });
				stream.feedAll(cycle);
				stream.drain();
			}
		});
		for (const stream of streams) {
			const budget = stream.budget();
			// The queue high-water is a whole cycle's backlog — never more, because we drain per cycle.
			expect(budget.queueHighWaterBytes).toBe(cycleBytes);
			expect(budget.queueHighWaterEvents).toBe(shape.quietFrames + shape.burstFrames);
			expect(budget.drains).toBe(shape.cycles); // one catch-up drain per cycle
			expect(budget.frames).toBe(shape.cycles * (shape.quietFrames + shape.burstFrames));
			expect(budget.health).toBe("live");
		}
		streams.forEach((s) => s.dispose());
	});
});

describe("stalled observer", () => {
	it.each(STREAM_COUNTS)("backs the queue up to the full backlog, then catches up in one drain (%i stream(s))", async (count) => {
		const streams = await makeFleet(count);
		const frames = 300;
		const bytesPerFrame = 256;
		streams.forEach((stream, index) => {
			const load = steadyFrames(mulberry32(300 + index), { frames, bytesPerFrame });
			stream.feedAll(load); // observer stalled: fed but never drained
		});
		for (const stream of streams) {
			// Before catch-up the whole backlog is queued and still under the caps.
			expect(stream.queueHighWaterBytes).toBe(frames * bytesPerFrame);
			expect(stream.queueHighWaterEvents).toBe(frames);
			expect(stream.queueHighWaterBytes).toBeLessThan(DEFAULT_PARSER_QUEUE_MAX_BYTES);
			expect(stream.queueHighWaterEvents).toBeLessThan(DEFAULT_PARSER_QUEUE_MAX_EVENTS);
		}
		streams.forEach((s) => expect(s.drain()).toBe(1)); // exactly one scheduled drain absorbs it all
		for (const stream of streams) {
			const budget = stream.budget();
			expect(budget.drains).toBe(1);
			expect(budget.frames).toBe(frames);
			expect(budget.watermarkSeq).toBe(frames);
			expect(budget.health).toBe("live");
			expect(budget.overflow.droppedChunks).toBe(0);
		}
		streams.forEach((s) => s.dispose());
	});
});

describe("sequence gap followed by resync", () => {
	it("detects a gap when a stalled observer's frames roll off the journal, then resumes forward", () => {
		let journal = emptyJournal();
		const maxBytes = 512; // small cap forces old frames to roll off
		const observerWatermark = 3; // observer last saw seq 3, then stalled
		for (let seq = 0; seq < 40; seq++) {
			journal = recordJournalFrame(journal, seq, steadyChunk(mulberry32(seq), 48), maxBytes);
		}
		const plan = planResync(journal, observerWatermark);
		expect(journal.bytes).toBeLessThanOrEqual(maxBytes);
		expect(plan.firstRetainedSeq).not.toBeNull();
		expect(plan.lastRetainedSeq).toBe(39); // newest frame always retained
		expect(plan.gap).toBeGreaterThan(0); // frames between the watermark and the tail were lost
		expect(plan.gap).toBe((plan.firstRetainedSeq as number) - (observerWatermark + 1));
		expect(plan.resumeSeq).toBe(plan.firstRetainedSeq); // resume forward, never replay the hole
		expect(plan.replayedFrames).toBeGreaterThan(0);
	});

	it("resyncs cleanly with no gap when the journal still covers the watermark", () => {
		let journal = emptyJournal();
		for (let seq = 0; seq < 5; seq++) {
			journal = recordJournalFrame(journal, seq, steadyChunk(mulberry32(seq), 8), DEFAULT_JOURNAL_MAX_BYTES);
		}
		const plan = planResync(journal, 2);
		expect(plan.gap).toBe(0);
		expect(plan.resumeSeq).toBe(3); // one past the watermark
		expect(plan.replayedFrames).toBe(2); // seqs 3 and 4
	});

	it("feeds the resync tail into a fresh parser whose watermark advances monotonically", async () => {
		const clockA = new SteppingClock(1);
		const schedulerA = new DeterministicScheduler();
		const before = await makeStream({ streamId: "resync-a", clock: clockA, scheduler: schedulerA });
		before.feedAll(steadyFrames(mulberry32(7), { frames: 10, bytesPerFrame: 32 }));
		before.drain();
		const lastGood = before.budget();
		expect(lastGood.watermarkSeq).toBe(10);

		// A fresh parser resumes from the retained tail; its watermark climbs from zero, monotonically.
		const after = await makeStream({ streamId: "resync-b", clock: new SteppingClock(1), scheduler: new DeterministicScheduler() });
		const tail = steadyFrames(mulberry32(8), { frames: 6, bytesPerFrame: 32 });
		let previous = 0;
		for (const frame of tail) {
			after.feed(frame);
			after.drain();
			const watermark = after.budget().watermarkSeq;
			expect(watermark).toBeGreaterThan(previous);
			previous = watermark;
		}
		expect(after.budget().health).toBe("live");
		before.dispose();
		after.dispose();
	});
});

describe("bounded queue overflow", () => {
	it("flips to an explicit overflowed verdict on the byte cap and stops parsing", async () => {
		const stream = await makeStream({ queueMaxBytes: 64 });
		stream.feed({ kind: "output", bytes: steadyChunk(mulberry32(1), 40) }); // accepted
		stream.feed({ kind: "output", bytes: steadyChunk(mulberry32(2), 40) }); // dropped — over 64
		expect(stream.mirror.overflowed).toBe(true);
		const drainsBefore = stream.drain(); // one drain flips the pipeline to overflowed
		expect(drainsBefore).toBe(1);
		const budget = stream.budget();
		expect(budget.health).toBe("overflowed");
		expect(budget.overflow.droppedChunks).toBe(1);
		expect(budget.overflow.droppedBytes).toBe(40);
		// The pipeline's own overflow accounting matches the mirror fed the identical stream.
		expect(budget.overflow).toEqual(stream.mirror.overflow);
		// Post-verdict traffic is a bounded no-op: no further drains, verdict unchanged.
		stream.feed({ kind: "output", bytes: steadyChunk(mulberry32(3), 8) });
		expect(stream.drain()).toBe(0);
		expect(stream.budget().health).toBe("overflowed");
		stream.dispose();
	});

	it("flips to overflowed on the event cap and counts the dropped chunk", async () => {
		const stream = await makeStream({ queueMaxEvents: 2 });
		for (let i = 0; i < 3; i++) stream.feed({ kind: "output", bytes: steadyChunk(mulberry32(i), 4) });
		expect(stream.mirror.overflow.droppedChunks).toBe(1);
		stream.drain();
		expect(stream.budget().health).toBe("overflowed");
		stream.dispose();
	});

	it("counts a dropped resize separately from dropped output on the raw queue", () => {
		const queue = new ParserEventQueue(1024, 2);
		expect(queue.enqueueResize(80, 24)).toBe(true);
		expect(queue.enqueueResize(81, 24)).toBe(true);
		expect(queue.enqueueResize(82, 24)).toBe(false);
		expect(queue.overflow.droppedResizes).toBe(1);
		expect(queue.overflowed).toBe(true);
	});
});

describe("snapshot size budget", () => {
	it("measures a bounded, schema-valid worst-case snapshot for a wide terminal", async () => {
		const stream = await makeStream({
			cols: 120,
			rows: 40,
			snapshotScrollbackCap: DEFAULT_SNAPSHOT_SCROLLBACK_CAP,
			scrollbackLength: 1000,
		});
		stream.feedAll(steadyFrames(mulberry32(9), { frames: 5, bytesPerFrame: 64 }));
		stream.drain();
		const budget = stream.budget();
		expect(budget.snapshotBytes).toBeGreaterThan(50_000); // full screen + capped scrollback is substantial
		expect(budget.snapshotBytes).toBeLessThan(5_000_000); // but bounded, never unbounded replay
		// The measured snapshot is a legal parser-state snapshot per the real validator.
		const snapshot = stream.pipeline.snapshot();
		expect(() => parseParserStateSnapshot(JSON.stringify(snapshot))).not.toThrow();
		expect(snapshot.state?.scrollback.length).toBe(DEFAULT_SNAPSHOT_SCROLLBACK_CAP);
		expect(snapshot.state?.scrollbackLength).toBe(1000);
		stream.dispose();
	});
});

describe("replies budget", () => {
	it("answers each device-status query with exactly one reply", async () => {
		const stream = await makeStream();
		const frames: HarnessFrame[] = [
			{ kind: "output", bytes: DSR_QUERY },
			{ kind: "output", bytes: DSR_QUERY },
		];
		stream.feedAll(frames);
		stream.drain();
		const budget = stream.budget();
		expect(budget.replies).toBe(2);
		expect(stream.replies).toEqual(["\x1b[1;1R", "\x1b[1;1R"]);
		stream.dispose();
	});
});

describe("cleanup semantics", () => {
	it("dispose() frees the core and makes further traffic a no-op", async () => {
		const stream = await makeStream();
		stream.feedAll(steadyFrames(mulberry32(5), { frames: 3, bytesPerFrame: 16 }));
		stream.drain();
		const framesBefore = stream.core.ingestedFrames;
		stream.dispose();
		expect(stream.core.disposed).toBe(true);
		stream.feed({ kind: "output", bytes: steadyChunk(mulberry32(6), 16) });
		stream.drain();
		expect(stream.core.ingestedFrames).toBe(framesBefore); // ignored after dispose
	});

	it("clear() empties the raw queue but preserves the overflow verdict", () => {
		const queue = new ParserEventQueue(4);
		queue.enqueueOutput(steadyChunk(mulberry32(1), 4));
		queue.enqueueOutput(steadyChunk(mulberry32(2), 4)); // dropped
		queue.clear();
		expect(queue.pendingEvents).toBe(0);
		expect(queue.pendingBytes).toBe(0);
		expect(queue.overflowed).toBe(true);
	});
});

describe("existing caps are what the harness assumes", () => {
	it("pins the parser-queue, journal, and snapshot caps", () => {
		expect(DEFAULT_PARSER_QUEUE_MAX_BYTES).toBe(8 * 1024 * 1024);
		expect(DEFAULT_PARSER_QUEUE_MAX_EVENTS).toBe(65_536);
		expect(DEFAULT_JOURNAL_MAX_BYTES).toBe(256 * 1024);
		expect(DEFAULT_SNAPSHOT_SCROLLBACK_CAP).toBe(200);
	});
});
