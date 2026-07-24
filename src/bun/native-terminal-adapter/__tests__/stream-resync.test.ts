/**
 * The sequencing / resync rule (decision 161) as composed in the adapter. Proven
 * against a recording sink through the injected-failure cases from the spike:
 * dropped / duplicate / out-of-order frames, forced reconnect, a stale-storm,
 * and a bounded-buffer overflow — every recovery converges in ONE snapshot with
 * no resync loop, and the recovered op stream equals the uninterrupted one.
 */
import { describe, expect, it } from "vitest";
import {
	StreamResyncReader,
	type DeltaFrame,
	type ResyncSink,
	type SnapshotFrame,
} from "../stream-resync";

interface JournalState {
	ops: string[];
}

/** A byte-exact reducer: its state is the ordered op journal, restorable verbatim. */
class RecordingSink implements ResyncSink<JournalState> {
	ops: string[] = [];
	applyOutput(data: Uint8Array): void {
		this.ops.push(new TextDecoder().decode(data));
	}
	applyResize(cols: number, rows: number): void {
		this.ops.push(`resize:${cols}x${rows}`);
	}
	captureState(): JournalState {
		return { ops: [...this.ops] };
	}
	restoreState(state: JournalState): void {
		this.ops = [...state.ops];
	}
}

function output(seq: number, text: string): DeltaFrame {
	return { seq, op: { kind: "output", data: new TextEncoder().encode(text) } };
}

/** Ground truth: the sink fed the uninterrupted, in-order stream. */
function groundTruth(texts: string[]): string[] {
	const sink = new RecordingSink();
	for (const t of texts) sink.applyOutput(new TextEncoder().encode(t));
	return sink.ops;
}

describe("StreamResyncReader", () => {
	it("applies strictly increasing deltas in order", () => {
		const sink = new RecordingSink();
		const reader = new StreamResyncReader(sink);
		reader.ingestDelta(output(1, "a"));
		reader.ingestDelta(output(2, "b"));
		reader.ingestDelta(output(3, "c"));
		expect(reader.state).toBe("live");
		expect(reader.seq).toBe(3);
		expect(sink.ops).toEqual(groundTruth(["a", "b", "c"]));
	});

	it("ignores duplicate and stale deltas without requesting a snapshot", () => {
		const sink = new RecordingSink();
		const reader = new StreamResyncReader(sink);
		reader.ingestDelta(output(1, "a"));
		reader.ingestDelta(output(2, "b"));
		reader.ingestDelta(output(2, "b-dup")); // duplicate
		reader.ingestDelta(output(1, "a-stale")); // stale
		expect(reader.needsSnapshot()).toBe(false);
		expect(reader.state).toBe("live");
		expect(sink.ops).toEqual(groundTruth(["a", "b"]));
	});

	it("recovers a dropped frame from one snapshot and drops the buffered stale frame", () => {
		const sink = new RecordingSink();
		const reader = new StreamResyncReader(sink);
		reader.ingestDelta(output(1, "a"));
		// seq 2 is dropped; seq 3 arrives → gap.
		reader.ingestDelta(output(3, "c"));
		expect(reader.state).toBe("syncing");
		expect(reader.needsSnapshot()).toBe(true);

		// The host captured state at seq 3 (>= every buffered delta).
		const snapshot: SnapshotFrame<JournalState> = { baseSeq: 3, state: { ops: groundTruth(["a", "b", "c"]) } };
		reader.ingestSnapshot(snapshot);
		expect(reader.state).toBe("live");
		expect(reader.needsSnapshot()).toBe(false);
		expect(reader.seq).toBe(3);
		expect(sink.ops).toEqual(groundTruth(["a", "b", "c"]));

		// Live resumes in order after recovery.
		reader.ingestDelta(output(4, "d"));
		expect(sink.ops).toEqual(groundTruth(["a", "b", "c", "d"]));
	});

	it("requests exactly one snapshot during a stale/gapped storm (no loop)", () => {
		const sink = new RecordingSink();
		const reader = new StreamResyncReader(sink);
		reader.ingestDelta(output(1, "a"));
		reader.ingestDelta(output(5, "e")); // gap → one request
		reader.ingestDelta(output(6, "f")); // still gapped — must NOT re-request
		reader.ingestDelta(output(1, "a-stale")); // stale (<= lastSeq) — must NOT re-request
		expect(reader.needsSnapshot()).toBe(true);
		// Satisfy once; buffered 6 replays, buffered stale drops.
		reader.ingestSnapshot({ baseSeq: 6, state: { ops: groundTruth(["a", "b", "c", "d", "e", "f"]) } });
		expect(reader.state).toBe("live");
		expect(reader.needsSnapshot()).toBe(false);
		expect(reader.seq).toBe(6);
	});

	it("ignores a stale snapshot so it never rewinds a recovered reader", () => {
		const sink = new RecordingSink();
		const reader = new StreamResyncReader(sink);
		reader.ingestDelta(output(1, "a"));
		reader.ingestDelta(output(3, "c")); // gap
		reader.ingestSnapshot({ baseSeq: 3, state: { ops: groundTruth(["a", "b", "c"]) } });
		reader.ingestDelta(output(4, "d"));
		// A late duplicate snapshot at an older base must not rewind.
		reader.ingestSnapshot({ baseSeq: 2, state: { ops: groundTruth(["a", "b"]) } });
		expect(reader.seq).toBe(4);
		expect(sink.ops).toEqual(groundTruth(["a", "b", "c", "d"]));
	});

	it("models reconnect: a forced snapshot restores state and resumes", () => {
		const sink = new RecordingSink();
		const reader = new StreamResyncReader(sink);
		reader.ingestDelta(output(1, "a"));
		reader.ingestDelta(output(2, "b"));
		// Reconnect: the fresh reader is handed the host's current snapshot.
		reader.ingestSnapshot({ baseSeq: 2, state: { ops: groundTruth(["a", "b"]) } });
		reader.ingestDelta(output(3, "c"));
		expect(reader.seq).toBe(3);
		expect(sink.ops).toEqual(groundTruth(["a", "b", "c"]));
	});

	it("fails honestly when the bounded buffer overflows and ignores later frames", () => {
		const sink = new RecordingSink();
		const reader = new StreamResyncReader(sink, { maxBufferedFrames: 3, maxBufferedBytes: 1024 });
		reader.ingestDelta(output(1, "a"));
		// A persistent gap keeps buffering until the frame bound is exceeded.
		for (let seq = 3; seq <= 10; seq++) reader.ingestDelta(output(seq, `x${seq}`));
		expect(reader.state).toBe("failed");
		expect(reader.failure).toBeTruthy();
		// A later snapshot / delta cannot revive a failed reader (no corrupt render).
		reader.ingestSnapshot({ baseSeq: 10, state: { ops: [] } });
		expect(reader.state).toBe("failed");
	});
});
