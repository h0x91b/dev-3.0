import { describe, expect, it } from "vitest";
import { type ClientHandle, ResyncHarness } from "../harness";
import {
	deltaByteSize,
	isHostFrame,
	outputDelta,
	RESYNC_PROTOCOL_VERSION,
	resizeDelta,
	snapshotFrame,
} from "../protocol";
import { StreamSequencer } from "../sequencer";
import {
	ByteJournalTerminal,
	GRID_SINK,
	GridTerminal,
	JOURNAL_SINK,
	type SinkFactory,
} from "../terminal-model";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function expectRecovered(harness: ResyncHarness, handle: ClientHandle): void {
	expect(handle.client.modeName).toBe("live");
	expect(handle.client.stats().failure).toBeNull();
	expect(handle.sink.captureState()).toEqual(harness.groundTruthState());
	expect(handle.client.stats().lastSeq).toBe(harness.sequencer.currentSeq);
}

// ── Sequence model applies identically regardless of terminal backend ──────
for (const factory of [GRID_SINK, JOURNAL_SINK] satisfies SinkFactory[]) {
	describe(`resync recovery (${factory.name} sink)`, () => {
		const dimensions = { cols: 24, rows: 4 };
		const newHarness = () => new ResyncHarness({ dimensions, sink: factory });

		it("applies every delta in order with no resync on a clean link", () => {
			const harness = newHarness();
			const client = harness.addClient("c1");
			harness.attach(client);

			harness.emitOutput("café €\r\n");
			harness.emitOutput("second line");
			harness.emitResize(16, 3);
			harness.emitOutput("!");

			expectRecovered(harness, client);
			const stats = client.client.stats();
			expect(stats.gapsDetected).toBe(0);
			expect(stats.appliedDeltas).toBe(4);
			expect(stats.snapshotsApplied).toBe(1); // only the initial attach snapshot
		});

		it("recovers from a dropped frame with exactly one fresh snapshot", () => {
			const harness = newHarness();
			const client = harness.addClient("c1");
			harness.attach(client);

			harness.emitOutput("aaa"); // seq 1
			client.link.schedule("drop");
			harness.emitOutput("bbb"); // seq 2 — dropped
			harness.emitOutput("ccc"); // seq 3 — gap detected here
			harness.emitOutput("ddd"); // seq 4 — resumed live

			expectRecovered(harness, client);
			const stats = client.client.stats();
			expect(stats.gapsDetected).toBe(1);
			expect(stats.snapshotsApplied).toBe(2); // initial + one resync
			expect(stats.snapshotRequests).toBe(2);
		});

		it("ignores a duplicate frame without resyncing", () => {
			const harness = newHarness();
			const client = harness.addClient("c1");
			harness.attach(client);

			harness.emitOutput("aa"); // seq 1
			client.link.schedule("duplicate");
			harness.emitOutput("bb"); // seq 2 — delivered twice
			harness.emitOutput("cc"); // seq 3

			expectRecovered(harness, client);
			const stats = client.client.stats();
			expect(stats.ignoredDuplicates).toBe(1);
			expect(stats.gapsDetected).toBe(0);
			expect(stats.snapshotsApplied).toBe(1);
		});

		it("recovers from an out-of-order frame and ignores the late arrival", () => {
			const harness = newHarness();
			const client = harness.addClient("c1");
			harness.attach(client);

			harness.emitOutput("11"); // seq 1
			client.link.schedule("hold");
			harness.emitOutput("22"); // seq 2 — held back
			harness.emitOutput("33"); // seq 3 — arrives before 2 → gap
			client.link.flushHeld(); // seq 2 arrives late → stale
			harness.emitOutput("44"); // seq 4

			expectRecovered(harness, client);
			const stats = client.client.stats();
			expect(stats.gapsDetected).toBe(1);
			expect(stats.ignoredStale).toBeGreaterThanOrEqual(1);
			expect(stats.snapshotRequests).toBe(2); // initial + one resync, no loop
		});

		it("resyncs after a disconnect and reconnect", () => {
			const harness = newHarness();
			const client = harness.addClient("c1");
			harness.attach(client);

			harness.emitOutput("before\r\n"); // seq 1
			client.link.disconnect();
			harness.emitOutput("lost-1"); // seq 2 — never delivered
			harness.emitOutput("lost-2"); // seq 3 — never delivered
			client.link.reconnect();
			client.client.notifyReconnected(); // forces a fresh snapshot
			harness.emitOutput("after"); // seq 4

			expectRecovered(harness, client);
			expect(client.client.stats().snapshotsApplied).toBe(2);
		});

		it("does not loop on a storm of stale and duplicate frames", () => {
			const harness = newHarness();
			const client = harness.addClient("c1");
			harness.attach(client);

			harness.emitOutput("one"); // 1
			harness.emitOutput("two"); // 2
			harness.emitOutput("three"); // 3
			const before = client.client.stats();

			// Re-deliver old frames the transport might echo: all must be ignored.
			client.client.receiveFrame(outputDelta(2, encode("stale")));
			client.client.receiveFrame(outputDelta(2, encode("stale")));
			client.client.receiveFrame(outputDelta(3, encode("dup-latest")));

			const after = client.client.stats();
			expect(after.gapsDetected).toBe(before.gapsDetected);
			expect(after.snapshotRequests).toBe(before.snapshotRequests);
			expect(after.ignoredStale).toBeGreaterThan(before.ignoredStale);
			expect(after.ignoredDuplicates).toBeGreaterThan(before.ignoredDuplicates);
			expectRecovered(harness, client);
		});

		it("lets two observers fall behind and resync independently", () => {
			const harness = newHarness();
			const observerA = harness.addClient("a");
			const observerB = harness.addClient("b");
			harness.attach(observerA);
			harness.attach(observerB);

			const writerBefore = harness.sequencer.writerId;
			const dimensionsBefore = harness.sequencer.dimensions;

			harness.emitOutput("shared-1"); // 1 — both
			observerA.link.schedule("drop");
			harness.emitOutput("shared-2"); // 2 — A drops
			harness.emitOutput("shared-3"); // 3 — A resyncs
			observerB.link.schedule("drop");
			harness.emitOutput("shared-4"); // 4 — B drops
			harness.emitOutput("shared-5"); // 5 — B resyncs

			expectRecovered(harness, observerA);
			expectRecovered(harness, observerB);
			expect(observerA.client.stats().gapsDetected).toBe(1);
			expect(observerB.client.stats().gapsDetected).toBe(1);
			// Resync is read-only: writer ownership and PTY size are untouched.
			expect(harness.sequencer.writerId).toBe(writerBefore);
			expect(harness.sequencer.dimensions).toEqual(dimensionsBefore);
		});

		it("fails honestly when the resync queue bound is exceeded", () => {
			const harness = newHarness();
			const client = harness.addClient("c1", { maxQueueFrames: 100, maxQueueBytes: 20 });
			harness.attach(client);

			harness.emitOutput("a"); // seq 1 — applied live
			client.blockSnapshots = true; // stall the resync so the queue backs up
			client.link.schedule("drop");
			harness.emitOutput("b"); // seq 2 — dropped
			harness.emitOutput("c"); // seq 3 — gap, resync stalls
			for (let i = 0; i < 10; i++) harness.emitOutput("floooood"); // pile up during resync

			expect(client.client.modeName).toBe("failed");
			expect(client.client.stats().failure).toContain("bound exceeded");

			// A failed client stays failed and never crashes on later frames.
			harness.emitOutput("z");
			expect(client.client.modeName).toBe("failed");
		});
	});
}

// ── Backend-neutrality is concrete: the journal sink is byte-exact ─────────
describe("byte-exact reconstruction (journal sink)", () => {
	it("reconstructs the uninterrupted byte stream after a drop", () => {
		const harness = new ResyncHarness({ dimensions: { cols: 20, rows: 4 }, sink: JOURNAL_SINK });
		const client = harness.addClient("c1");
		harness.attach(client);

		harness.emitOutput("alpha");
		client.link.schedule("drop");
		harness.emitOutput("beta"); // dropped → forces resync
		harness.emitOutput("gamma");
		harness.emitOutput("delta");

		expectRecovered(harness, client);
		const recovered = client.sink as ByteJournalTerminal;
		const truth = harness.groundTruth as ByteJournalTerminal;
		expect(recovered.bytes()).toEqual(truth.bytes());
		expect(new TextDecoder().decode(recovered.bytes())).toBe("alphabetagammadelta");
	});
});

// ── GridTerminal is a real, snapshot-able reducer ─────────────────────────
describe("GridTerminal reducer", () => {
	it("renders printable text, CR/LF, and cursor addressing", () => {
		const term = new GridTerminal({ cols: 10, rows: 3 });
		term.applyOutput(encode("hi\r\nthere"));
		term.applyOutput(encode("\x1b[1;1Hymca"));
		const lines = term.render().split("\n");
		expect(lines[0]).toBe("ymca      ");
		expect(lines[1]).toBe("there     ");
	});

	it("clears the screen with CSI 2J", () => {
		const term = new GridTerminal({ cols: 5, rows: 2 });
		term.applyOutput(encode("junk\x1b[2J"));
		expect(term.render()).toBe(["     ", "     "].join("\n"));
	});

	it("restores a multi-byte glyph split across a snapshot boundary", () => {
		const euro = encode("€"); // 3 bytes: E2 82 AC
		const source = new GridTerminal({ cols: 8, rows: 1 });
		source.applyOutput(euro.slice(0, 2)); // decoder now holds two pending bytes

		const wireState = JSON.parse(JSON.stringify(source.captureState()));
		const restored = new GridTerminal({ cols: 8, rows: 1 });
		restored.restoreState(wireState);

		const tail = new Uint8Array([euro[2], ...encode("Z")]);
		source.applyOutput(tail);
		restored.applyOutput(tail);

		expect(restored.captureState()).toEqual(source.captureState());
		expect(restored.render()).toBe("€Z      ");
	});

	it("restores a CSI sequence split across a snapshot boundary", () => {
		const source = new GridTerminal({ cols: 6, rows: 2 });
		source.applyOutput(encode("ab\x1b[2")); // parser mid-CSI

		const restored = new GridTerminal({ cols: 6, rows: 2 });
		restored.restoreState(JSON.parse(JSON.stringify(source.captureState())));

		const tail = encode(";1Hz"); // completes cursor-position then prints
		source.applyOutput(tail);
		restored.applyOutput(tail);

		expect(restored.captureState()).toEqual(source.captureState());
		expect(restored.render().split("\n")[1]).toBe("z     ");
	});
});

describe("ByteJournalTerminal reducer", () => {
	it("round-trips its op journal through capture/restore", () => {
		const source = new ByteJournalTerminal();
		source.applyOutput(encode("one"));
		source.applyResize(10, 5);
		source.applyOutput(encode("two"));

		const restored = new ByteJournalTerminal();
		restored.restoreState(JSON.parse(JSON.stringify(source.captureState())));
		restored.applyOutput(encode("three"));
		source.applyOutput(encode("three"));

		expect(restored.captureState()).toEqual(source.captureState());
		expect(new TextDecoder().decode(restored.bytes())).toBe("onetwothree");
	});
});

// ── Sequencer + protocol units ────────────────────────────────────────────
describe("StreamSequencer", () => {
	it("assigns strictly increasing sequence numbers", () => {
		const sequencer = new StreamSequencer(new ByteJournalTerminal(), {
			writerId: "w",
			dimensions: { cols: 80, rows: 24 },
		});
		expect(sequencer.emitOutput(encode("a")).seq).toBe(1);
		expect(sequencer.emitOutput(encode("b")).seq).toBe(2);
		expect(sequencer.emitResize(100, 30).seq).toBe(3);
		expect(sequencer.currentSeq).toBe(3);
	});

	it("captures a snapshot at the current seq without changing writer or size", () => {
		const sequencer = new StreamSequencer(new GridTerminal({ cols: 80, rows: 24 }), {
			writerId: "writer-x",
			dimensions: { cols: 80, rows: 24 },
		});
		sequencer.emitOutput(encode("hello"));
		sequencer.emitResize(120, 40);
		const snapshot = sequencer.captureSnapshot();

		expect(snapshot.baseSeq).toBe(2);
		expect(sequencer.currentSeq).toBe(2); // capture did not advance the stream
		expect(sequencer.writerId).toBe("writer-x");
		expect(sequencer.dimensions).toEqual({ cols: 120, rows: 40 });
	});
});

describe("protocol helpers", () => {
	it("builds versioned frames", () => {
		expect(outputDelta(1, encode("x"))).toMatchObject({ v: RESYNC_PROTOCOL_VERSION, type: "delta", seq: 1 });
		expect(resizeDelta(2, 10, 5)).toMatchObject({ type: "delta", op: { kind: "resize", cols: 10, rows: 5 } });
		expect(snapshotFrame(7, { a: 1 })).toMatchObject({ type: "snapshot", baseSeq: 7 });
	});

	it("validates host frames and rejects foreign versions", () => {
		expect(isHostFrame(outputDelta(1, encode("x")))).toBe(true);
		expect(isHostFrame(snapshotFrame(0, {}))).toBe(true);
		expect(isHostFrame({ v: 99, type: "delta", seq: 1, op: {} })).toBe(false);
		expect(isHostFrame(null)).toBe(false);
	});

	it("charges output by byte length and resize by a fixed cost", () => {
		expect(deltaByteSize({ kind: "output", data: encode("abcd") })).toBe(4);
		expect(deltaByteSize({ kind: "resize", cols: 1, rows: 1 })).toBe(8);
	});
});
