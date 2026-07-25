import { describe, expect, it } from "vitest";
import { ParserEventQueue } from "../parser-queue";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("ParserEventQueue", () => {
	it("preserves enqueue order across output and resize events", () => {
		const queue = new ParserEventQueue();
		queue.enqueueOutput(bytes("one"));
		queue.enqueueResize(120, 40);
		queue.enqueueOutput(bytes("two"));
		const drained = queue.drain();
		expect(drained.map((e) => e.kind)).toEqual(["output", "resize", "output"]);
		expect(drained.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(queue.pendingEvents).toBe(0);
		expect(queue.pendingBytes).toBe(0);
	});

	it("copies enqueued chunks so a reused callback buffer cannot mutate the queue", () => {
		const queue = new ParserEventQueue();
		const buffer = bytes("abc");
		queue.enqueueOutput(buffer);
		buffer[0] = 0x7a;
		const [event] = queue.drain();
		expect(event.kind).toBe("output");
		expect(new TextDecoder().decode((event as { bytes: Uint8Array }).bytes)).toBe("abc");
	});

	it("drops a chunk that would exceed the byte cap and counts it explicitly", () => {
		const queue = new ParserEventQueue(8);
		expect(queue.enqueueOutput(bytes("12345"))).toBe(true);
		expect(queue.enqueueOutput(bytes("6789"))).toBe(false);
		expect(queue.overflowed).toBe(true);
		expect(queue.overflow).toEqual({ droppedChunks: 1, droppedBytes: 4, droppedResizes: 0 });
		// The already-queued chunk is untouched.
		const drained = queue.drain();
		expect(drained).toHaveLength(1);
		expect(drained[0].seq).toBe(1);
	});

	it("keeps accepting nothing new after clear() during an overflow shutdown", () => {
		const queue = new ParserEventQueue(4);
		queue.enqueueOutput(bytes("1234"));
		queue.enqueueOutput(bytes("5"));
		queue.clear();
		expect(queue.pendingEvents).toBe(0);
		expect(queue.pendingBytes).toBe(0);
		// Overflow accounting survives the clear — the verdict must stay explicit.
		expect(queue.overflowed).toBe(true);
	});

	it("caps the event count and counts dropped resizes separately", () => {
		const queue = new ParserEventQueue(1024, 2);
		expect(queue.enqueueResize(80, 24)).toBe(true);
		expect(queue.enqueueResize(81, 24)).toBe(true);
		expect(queue.enqueueResize(82, 24)).toBe(false);
		expect(queue.overflow.droppedResizes).toBe(1);
		expect(queue.overflowed).toBe(true);
	});

	it("ignores empty chunks without consuming capacity", () => {
		const queue = new ParserEventQueue(4);
		expect(queue.enqueueOutput(new Uint8Array(0))).toBe(true);
		expect(queue.pendingEvents).toBe(0);
		expect(queue.lastSeq).toBe(1);
	});

	it("tracks lastSeq across drops so a watermark stays monotonic", () => {
		const queue = new ParserEventQueue(2);
		queue.enqueueOutput(bytes("aa"));
		queue.enqueueOutput(bytes("bb")); // dropped
		queue.enqueueResize(100, 30);
		expect(queue.lastSeq).toBe(3);
		const drained = queue.drain();
		expect(drained.map((e) => e.seq)).toEqual([1, 3]);
	});
});

describe("ParserEventQueue observability", () => {
	it("keeps high-water marks across drains and clears", () => {
		const queue = new ParserEventQueue();
		queue.enqueueOutput(bytes("aaaa"));
		queue.enqueueOutput(bytes("bbbb"));
		expect(queue.highWater).toEqual({ bytes: 8, events: 2 });
		queue.drain();
		expect(queue.pendingBytes).toBe(0);
		expect(queue.highWater).toEqual({ bytes: 8, events: 2 });
		queue.enqueueOutput(bytes("c"));
		queue.clear();
		expect(queue.highWater).toEqual({ bytes: 8, events: 2 });
	});

	it("flags a slow consumer once the backlog crosses the configured ratio", () => {
		const queue = new ParserEventQueue(100, 1_000, 0.5);
		queue.enqueueOutput(bytes("x".repeat(40)));
		expect(queue.pressure).toBe("nominal");
		queue.enqueueOutput(bytes("x".repeat(20)));
		expect(queue.pressure).toBe("slow-consumer");
		expect(queue.counters().slowConsumerEpisodes).toBe(1);
		// Draining clears the pressure; backing up again is a SECOND episode.
		queue.drain();
		expect(queue.pressure).toBe("nominal");
		queue.enqueueOutput(bytes("x".repeat(60)));
		expect(queue.counters().slowConsumerEpisodes).toBe(2);
	});

	it("reports overflowed pressure and never exposes the pending events", () => {
		const queue = new ParserEventQueue(8, 1_000);
		queue.enqueueOutput(bytes("12345678"));
		queue.enqueueOutput(bytes("9")); // dropped
		const counters = queue.counters();
		expect(counters.pressure).toBe("overflowed");
		expect(counters.overflow).toEqual({ droppedChunks: 1, droppedBytes: 1, droppedResizes: 0 });
		expect(counters.maxBytes).toBe(8);
		expect(Object.values(counters).some((value) => Array.isArray(value))).toBe(false);
	});

	it("returns a copied overflow record so a caller cannot mutate queue state", () => {
		const queue = new ParserEventQueue(4);
		queue.enqueueOutput(bytes("12345")); // dropped
		const counters = queue.counters();
		counters.overflow.droppedChunks = 99;
		expect(queue.counters().overflow.droppedChunks).toBe(1);
	});
});
