/**
 * Writer side of the stream-resync spike (see ./README.md).
 *
 * Owns one monotonic sequence counter and the authoritative terminal sink.
 * Emitting an op advances the seq and mutates the sink; capturing a snapshot is
 * read-only, so a slow observer's resync never changes writer ownership or size.
 */

import {
	type DeltaFrame,
	type SnapshotFrame,
	outputDelta,
	resizeDelta,
	snapshotFrame,
} from "./protocol";
import type { ResyncSink } from "./terminal-model";

export interface StreamSequencerOptions {
	writerId: string | null;
	dimensions: { cols: number; rows: number };
}

export class StreamSequencer {
	readonly writerId: string | null;
	private seq = 0;
	private cols: number;
	private rows: number;

	constructor(
		private readonly sink: ResyncSink,
		options: StreamSequencerOptions,
	) {
		this.writerId = options.writerId;
		this.cols = options.dimensions.cols;
		this.rows = options.dimensions.rows;
	}

	get currentSeq(): number {
		return this.seq;
	}

	get dimensions(): { cols: number; rows: number } {
		return { cols: this.cols, rows: this.rows };
	}

	emitOutput(data: Uint8Array): DeltaFrame {
		this.seq++;
		this.sink.applyOutput(data);
		return outputDelta(this.seq, data);
	}

	emitResize(cols: number, rows: number): DeltaFrame {
		this.seq++;
		this.cols = cols;
		this.rows = rows;
		this.sink.applyResize(cols, rows);
		return resizeDelta(this.seq, cols, rows);
	}

	/** Read-only: capturing a snapshot never changes writer ownership or size. */
	captureSnapshot(): SnapshotFrame {
		return snapshotFrame(this.seq, JSON.parse(JSON.stringify(this.sink.captureState())));
	}
}
