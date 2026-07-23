/**
 * Reader side of the stream-resync spike (see ./README.md).
 *
 * A client applies deltas strictly in order. The only rule:
 *   seq == lastSeq + 1  → apply
 *   seq <= lastSeq       → duplicate/stale, ignore (never resync)
 *   seq  > lastSeq + 1   → GAP: stop applying, buffer, request ONE snapshot
 *   snapshot(baseSeq)    → restore, set lastSeq=baseSeq, drain queue, resume
 *
 * Resync is one snapshot request guarded by a pending flag, so duplicates and
 * stale frames can never spin up a loop. The buffer is bounded; overflowing it
 * fails honestly instead of rendering corrupt state.
 */

import { type DeltaFrame, type HostFrame, type SnapshotFrame, deltaByteSize } from "./protocol";
import type { ResyncSink } from "./terminal-model";

export type ClientMode = "syncing" | "live" | "failed";

export interface StreamClientOptions {
	sink: ResyncSink;
	/** Ask the host for one fresh snapshot (delivered later as a snapshot frame). */
	requestSnapshot: () => void;
	maxQueueFrames: number;
	maxQueueBytes: number;
	/** Deep-copy snapshot state before restore (simulates crossing the wire). */
	cloneState?: (state: unknown) => unknown;
}

export interface ClientStats {
	mode: ClientMode;
	lastSeq: number;
	appliedDeltas: number;
	ignoredDuplicates: number;
	ignoredStale: number;
	ignoredStaleSnapshots: number;
	gapsDetected: number;
	snapshotsApplied: number;
	snapshotRequests: number;
	queuedFrames: number;
	queuedBytes: number;
	failure: string | null;
}

const identityClone = (state: unknown): unknown => state;

export class StreamClient {
	private mode: ClientMode = "syncing";
	private initialized = false;
	private lastSeq = 0;
	private pendingSnapshot = false;
	private readonly queue: DeltaFrame[] = [];
	private queuedBytes = 0;
	private failure: string | null = null;
	private readonly cloneState: (state: unknown) => unknown;

	private appliedDeltas = 0;
	private ignoredDuplicates = 0;
	private ignoredStale = 0;
	private ignoredStaleSnapshots = 0;
	private gapsDetected = 0;
	private snapshotsApplied = 0;
	private snapshotRequests = 0;

	constructor(private readonly options: StreamClientOptions) {
		this.cloneState = options.cloneState ?? identityClone;
	}

	get sink(): ResyncSink {
		return this.options.sink;
	}

	get modeName(): ClientMode {
		return this.mode;
	}

	/** Initial attach: no state yet, so request the first snapshot. */
	start(): void {
		this.requestResync();
	}

	stats(): ClientStats {
		return {
			mode: this.mode,
			lastSeq: this.lastSeq,
			appliedDeltas: this.appliedDeltas,
			ignoredDuplicates: this.ignoredDuplicates,
			ignoredStale: this.ignoredStale,
			ignoredStaleSnapshots: this.ignoredStaleSnapshots,
			gapsDetected: this.gapsDetected,
			snapshotsApplied: this.snapshotsApplied,
			snapshotRequests: this.snapshotRequests,
			queuedFrames: this.queue.length,
			queuedBytes: this.queuedBytes,
			failure: this.failure,
		};
	}

	receiveFrame(frame: HostFrame): void {
		if (this.mode === "failed") return;
		if (frame.type === "snapshot") this.handleSnapshot(frame);
		else this.handleDelta(frame);
	}

	/** Transport lost the connection; nothing arrives until reconnect. */
	notifyDisconnected(): void {
		if (this.mode === "failed") return;
		this.mode = "syncing";
	}

	/** Transport restored; missed deltas are unknown, so force a fresh snapshot. */
	notifyReconnected(): void {
		if (this.mode === "failed") return;
		this.mode = "syncing";
		this.pendingSnapshot = false;
		this.requestResync();
	}

	private handleDelta(delta: DeltaFrame): void {
		if (this.mode === "syncing") {
			this.enqueue(delta);
			return;
		}
		if (delta.seq <= this.lastSeq) {
			if (delta.seq === this.lastSeq) this.ignoredDuplicates++;
			else this.ignoredStale++;
			return;
		}
		if (delta.seq === this.lastSeq + 1) {
			this.applyOp(delta);
			this.lastSeq = delta.seq;
			this.appliedDeltas++;
			return;
		}
		this.gapsDetected++;
		this.mode = "syncing";
		this.enqueue(delta);
		this.requestResync();
	}

	private handleSnapshot(snapshot: SnapshotFrame): void {
		if (this.initialized && snapshot.baseSeq < this.lastSeq) {
			this.ignoredStaleSnapshots++;
			return;
		}
		this.options.sink.restoreState(this.cloneState(snapshot.state));
		this.lastSeq = snapshot.baseSeq;
		this.initialized = true;
		this.snapshotsApplied++;
		this.pendingSnapshot = false;
		this.mode = "live";
		this.drainQueue();
	}

	private drainQueue(): void {
		for (let i = this.queue.length - 1; i >= 0; i--) {
			if (this.queue[i].seq <= this.lastSeq) {
				this.queuedBytes -= deltaByteSize(this.queue[i].op);
				this.queue.splice(i, 1);
				this.ignoredStale++;
			}
		}
		let progress = true;
		while (progress) {
			progress = false;
			for (let i = 0; i < this.queue.length; i++) {
				if (this.queue[i].seq === this.lastSeq + 1) {
					const [delta] = this.queue.splice(i, 1);
					this.queuedBytes -= deltaByteSize(delta.op);
					this.applyOp(delta);
					this.lastSeq = delta.seq;
					this.appliedDeltas++;
					progress = true;
					break;
				}
			}
		}
		if (this.queue.length > 0) {
			this.mode = "syncing";
			this.requestResync();
		}
	}

	private enqueue(delta: DeltaFrame): void {
		const size = deltaByteSize(delta.op);
		if (
			this.queue.length + 1 > this.options.maxQueueFrames ||
			this.queuedBytes + size > this.options.maxQueueBytes
		) {
			this.fail(
				`resync queue bound exceeded (frames ${this.queue.length + 1}/${this.options.maxQueueFrames}, bytes ${this.queuedBytes + size}/${this.options.maxQueueBytes})`,
			);
			return;
		}
		this.queue.push(delta);
		this.queuedBytes += size;
	}

	private requestResync(): void {
		if (this.pendingSnapshot) return;
		this.pendingSnapshot = true;
		this.snapshotRequests++;
		this.options.requestSnapshot();
	}

	private applyOp(delta: DeltaFrame): void {
		if (delta.op.kind === "output") this.options.sink.applyOutput(delta.op.data);
		else this.options.sink.applyResize(delta.op.cols, delta.op.rows);
	}

	private fail(reason: string): void {
		this.mode = "failed";
		this.failure = reason;
		this.queue.length = 0;
		this.queuedBytes = 0;
	}
}
