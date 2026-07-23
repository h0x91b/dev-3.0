/**
 * Test harness wiring the stream-resync spike (see ./README.md).
 *
 * One sequencer + authoritative sink, one ground-truth sink fed the identical
 * uninterrupted stream, and any number of clients each behind their own FakeLink.
 * `expectRecovered` compares a client's reconstructed state to ground truth.
 */

import { StreamClient } from "./client";
import { FakeLink } from "./fake-transport";
import type { DeltaFrame } from "./protocol";
import { StreamSequencer } from "./sequencer";
import type { ResyncSink, SinkFactory } from "./terminal-model";

export interface HarnessOptions {
	dimensions: { cols: number; rows: number };
	sink: SinkFactory;
	writerId?: string | null;
}

export interface ClientHandle {
	id: string;
	client: StreamClient;
	link: FakeLink;
	sink: ResyncSink;
	blockSnapshots: boolean;
	snapshotPending: boolean;
	releaseSnapshot(): void;
}

const cloneState = (state: unknown): unknown => JSON.parse(JSON.stringify(state));

export class ResyncHarness {
	readonly sequencer: StreamSequencer;
	private readonly hostSink: ResyncSink;
	readonly groundTruth: ResyncSink;
	private readonly handles: ClientHandle[] = [];

	constructor(private readonly options: HarnessOptions) {
		this.hostSink = options.sink.create(options.dimensions);
		this.groundTruth = options.sink.create(options.dimensions);
		this.sequencer = new StreamSequencer(this.hostSink, {
			writerId: options.writerId ?? "writer-1",
			dimensions: options.dimensions,
		});
	}

	addClient(
		id: string,
		bounds?: { maxQueueFrames?: number; maxQueueBytes?: number },
	): ClientHandle {
		const sink = this.options.sink.create(this.options.dimensions);
		const handle = { id, sink, blockSnapshots: false, snapshotPending: false } as ClientHandle;
		const client = new StreamClient({
			sink,
			requestSnapshot: () => {
				if (handle.blockSnapshots) {
					handle.snapshotPending = true;
					return;
				}
				handle.link.deliverSnapshot(this.sequencer.captureSnapshot());
			},
			maxQueueFrames: bounds?.maxQueueFrames ?? 4096,
			maxQueueBytes: bounds?.maxQueueBytes ?? 1 << 20,
			cloneState,
		});
		const link = new FakeLink((frame) => client.receiveFrame(frame));
		handle.client = client;
		handle.link = link;
		handle.releaseSnapshot = () => {
			if (!handle.snapshotPending) return;
			handle.snapshotPending = false;
			handle.link.deliverSnapshot(this.sequencer.captureSnapshot());
		};
		this.handles.push(handle);
		return handle;
	}

	/** Attach a client mid-stream: it must resync from a fresh snapshot. */
	attach(handle: ClientHandle): void {
		handle.client.start();
	}

	emitOutput(data: string | Uint8Array): DeltaFrame {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		const delta = this.sequencer.emitOutput(bytes);
		this.groundTruth.applyOutput(bytes);
		this.broadcast(delta);
		return delta;
	}

	emitResize(cols: number, rows: number): DeltaFrame {
		const delta = this.sequencer.emitResize(cols, rows);
		this.groundTruth.applyResize(cols, rows);
		this.broadcast(delta);
		return delta;
	}

	groundTruthState(): unknown {
		return this.groundTruth.captureState();
	}

	private broadcast(delta: DeltaFrame): void {
		for (const handle of this.handles) handle.link.sendDelta(delta);
	}
}
