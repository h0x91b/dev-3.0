/**
 * Backend-neutral stream sequencing / resync rule for the native adapter
 * (decision 161, seq 1249 → adopted here for MIG-002 tracer seq 1254).
 *
 * This is the proven "detect a gap, recover from ONE bounded snapshot, never
 * loop" rule, re-implemented self-contained so the adapter never imports the
 * removable `prototypes/` spike (isolation). A reconnecting or slow reader
 * applies ordered deltas and, on a gap, restores from a single snapshot instead
 * of rendering corrupt state:
 *
 *   seq == lastSeq + 1  → apply, advance
 *   seq <= lastSeq      → duplicate / stale → ignore (NEVER resync)
 *   seq  > lastSeq + 1  → GAP → buffer (bounded), request ONE snapshot
 *   snapshot(baseSeq)   → restore, lastSeq = baseSeq, drain buffer, resume
 *
 * Convergence: `baseSeq` (the source's seq at capture) is `>=` every buffered
 * delta, so on restore the buffered frames all drop as stale in a single pass —
 * no resync loops. One outstanding request is guarded so a burst of gapped or
 * stale deltas triggers at most one snapshot. Overflowing the bounded buffer
 * fails honestly to `failed` rather than buffering without limit.
 */

/** A deterministic reducer that can apply ordered ops and capture/restore state. */
export interface ResyncSink<S = unknown> {
	applyOutput(data: Uint8Array): void;
	applyResize(cols: number, rows: number): void;
	/** Self-contained, restorable state at the current position. */
	captureState(): S;
	restoreState(state: S): void;
}

export type StreamOp =
	| { kind: "output"; data: Uint8Array }
	| { kind: "resize"; cols: number; rows: number };

/** Incremental op; `seq` is strictly increasing and 1-based. */
export interface DeltaFrame {
	seq: number;
	op: StreamOp;
}

/** Full state at `baseSeq`; the reader resumes with deltas whose seq > baseSeq. */
export interface SnapshotFrame<S = unknown> {
	baseSeq: number;
	state: S;
}

export type ResyncStatus = "live" | "syncing" | "failed";

export interface ResyncBounds {
	maxBufferedFrames: number;
	maxBufferedBytes: number;
}

export const DEFAULT_RESYNC_BOUNDS: ResyncBounds = {
	maxBufferedFrames: 1024,
	maxBufferedBytes: 4 * 1024 * 1024,
};

/** Cost a frame charges against the bounded resync buffer. */
export function deltaByteSize(op: StreamOp): number {
	return op.kind === "output" ? op.data.byteLength : 8;
}

/**
 * The reader half of the sequencing rule. Feed it ordered `delta` frames; when
 * `needsSnapshot()` turns true, hand it exactly one `snapshot` frame. The sink
 * always reflects the recovered, in-order state (or the read stops at `failed`).
 */
export class StreamResyncReader<S = unknown> {
	private lastSeq = 0;
	private status: ResyncStatus = "live";
	private pendingSnapshot = false;
	private failureReason: string | null = null;
	private readonly buffer: DeltaFrame[] = [];
	private bufferedBytes = 0;
	private readonly bounds: ResyncBounds;

	constructor(
		private readonly sink: ResyncSink<S>,
		bounds: Partial<ResyncBounds> = {},
	) {
		this.bounds = { ...DEFAULT_RESYNC_BOUNDS, ...bounds };
	}

	get seq(): number {
		return this.lastSeq;
	}

	get state(): ResyncStatus {
		return this.status;
	}

	get failure(): string | null {
		return this.failureReason;
	}

	/** True while exactly one snapshot is awaited after a detected gap. */
	needsSnapshot(): boolean {
		return this.pendingSnapshot;
	}

	/** Apply one ordered delta; returns the resulting status. */
	ingestDelta(frame: DeltaFrame): ResyncStatus {
		if (this.status === "failed") return this.status;
		if (frame.seq <= this.lastSeq) return this.status; // duplicate / stale — never resync
		if (frame.seq === this.lastSeq + 1) {
			this.applyOp(frame.op);
			this.lastSeq = frame.seq;
			if (this.status === "syncing" && !this.pendingSnapshot && this.buffer.length === 0) this.status = "live";
			return this.status;
		}
		// GAP — stop applying, buffer, request exactly one snapshot.
		this.status = "syncing";
		if (!this.bufferFrame(frame)) return this.status; // overflow → failed
		if (!this.pendingSnapshot) this.pendingSnapshot = true;
		return this.status;
	}

	/**
	 * Restore from the single requested snapshot, then drain buffered deltas. A
	 * stale snapshot (`baseSeq < lastSeq`) is ignored so it can never rewind a
	 * recovered reader.
	 */
	ingestSnapshot(frame: SnapshotFrame<S>): ResyncStatus {
		if (this.status === "failed") return this.status;
		this.pendingSnapshot = false;
		if (frame.baseSeq < this.lastSeq) return this.status; // stale snapshot — ignore, no rewind
		this.sink.restoreState(frame.state);
		this.lastSeq = frame.baseSeq;
		this.drainBuffer();
		if (!this.pendingSnapshot && this.buffer.length === 0) this.status = "live";
		return this.status;
	}

	private drainBuffer(): void {
		// Buffered frames are seq-ordered; after a fresh restore they are all <=
		// baseSeq and drop in a single pass (the no-loop invariant).
		const pending = this.buffer.splice(0).sort((a, b) => a.seq - b.seq);
		this.bufferedBytes = 0;
		for (const frame of pending) {
			if (frame.seq <= this.lastSeq) continue; // stale after restore — drop
			if (frame.seq === this.lastSeq + 1) {
				this.applyOp(frame.op);
				this.lastSeq = frame.seq;
				continue;
			}
			// A genuine remaining gap: buffer again and await one more snapshot.
			if (!this.bufferFrame(frame)) return;
			this.pendingSnapshot = true;
		}
	}

	private bufferFrame(frame: DeltaFrame): boolean {
		this.buffer.push(frame);
		this.bufferedBytes += deltaByteSize(frame.op);
		if (this.buffer.length > this.bounds.maxBufferedFrames || this.bufferedBytes > this.bounds.maxBufferedBytes) {
			this.status = "failed";
			this.failureReason = "resync buffer exceeded its bound";
			this.buffer.length = 0;
			this.bufferedBytes = 0;
			this.pendingSnapshot = false;
			return false;
		}
		return true;
	}

	private applyOp(op: StreamOp): void {
		if (op.kind === "output") this.sink.applyOutput(op.data);
		else this.sink.applyResize(op.cols, op.rows);
	}
}
