/**
 * Load/budget harness over the real native parser + resync primitives.
 *
 * Each StreamHarness drives ONE real LiveParserPipeline (with a fake WASM core
 * injected through the pipeline's own `createCore` seam — the only fake) and,
 * alongside it, a MIRROR ParserEventQueue fed the identical frame stream. The
 * pipeline's internal queue depth is not publicly observable, so the mirror —
 * same caps, same enqueue order — is what exposes the queue high-water marks
 * and overflow the integration work needs (see FINDINGS.md follow-up).
 *
 * The harness measures only what the public primitives expose: ingest totals
 * (bytes/frames/resizes/replies), drain iterations, watermark, health/overflow
 * verdict, and the serialized snapshot size. Nothing here touches a PTY, child
 * process, socket, filesystem, or real clock.
 */

import type { GhosttyLiveOptions, LiveParserCore, NativeSemanticState } from "../ghostty-live";
import { LiveParserPipeline } from "../live-parser";
import { ParserEventQueue, type ParserQueueOverflow } from "../parser-queue";
import type { ParserHealthStatus, ParserStateSnapshot } from "../parser-state";
import { SteppingClock, DeterministicScheduler } from "./clock";
import type { HarnessFrame } from "./generators";
import { buildSemanticState } from "./semantic-state";

const DSR_MARKER = "\x1b[6n";
const decoder = new TextDecoder();

/** Fake parser core: counts ingest, answers one reply per DSR query, emits a valid state. */
export class BudgetCore implements LiveParserCore {
	ingestedBytes = 0;
	ingestedFrames = 0;
	disposed = false;
	private cols: number;
	private rows: number;
	private pending: string[] = [];

	constructor(
		cols: number,
		rows: number,
		/** Total scrollback the core "holds"; inspect() caps what it materializes. */
		private readonly scrollbackLength: number,
	) {
		this.cols = cols;
		this.rows = rows;
	}

	ingest(data: Uint8Array): void {
		this.ingestedBytes += data.length;
		this.ingestedFrames++;
		const text = decoder.decode(data);
		let index = text.indexOf(DSR_MARKER);
		while (index >= 0) {
			this.pending.push("\x1b[1;1R");
			index = text.indexOf(DSR_MARKER, index + 1);
		}
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
	}

	readResponses(): string[] {
		return this.pending.splice(0, this.pending.length);
	}

	inspect(scrollbackCap: number): NativeSemanticState {
		return buildSemanticState({
			cols: this.cols,
			rows: this.rows,
			scrollbackLines: Math.min(scrollbackCap, this.scrollbackLength),
			scrollbackLength: this.scrollbackLength,
		});
	}

	dispose(): void {
		this.disposed = true;
	}
}

export interface StreamBudget {
	streamId: string;
	bytes: number;
	frames: number;
	resizes: number;
	replies: number;
	drains: number;
	queueHighWaterBytes: number;
	queueHighWaterEvents: number;
	snapshotBytes: number;
	watermarkSeq: number;
	overflow: ParserQueueOverflow;
	health: ParserHealthStatus;
}

export interface StreamHarnessOptions {
	streamId: string;
	clock: SteppingClock;
	scheduler: DeterministicScheduler;
	cols?: number;
	rows?: number;
	queueMaxBytes?: number;
	queueMaxEvents?: number;
	snapshotScrollbackCap?: number;
	scrollbackLength?: number;
}

export class StreamHarness {
	private highWaterBytes = 0;
	private highWaterEvents = 0;

	private constructor(
		readonly streamId: string,
		readonly pipeline: LiveParserPipeline,
		readonly core: BudgetCore,
		readonly mirror: ParserEventQueue,
		readonly snapshots: ParserStateSnapshot[],
		readonly replies: string[],
		private readonly scheduler: DeterministicScheduler,
	) {}

	static async create(opts: StreamHarnessOptions): Promise<StreamHarness> {
		const cols = opts.cols ?? 80;
		const rows = opts.rows ?? 24;
		const core = new BudgetCore(cols, rows, opts.scrollbackLength ?? 0);
		const mirror = new ParserEventQueue(opts.queueMaxBytes, opts.queueMaxEvents);
		const snapshots: ParserStateSnapshot[] = [];
		const replies: string[] = [];
		const pipeline = await LiveParserPipeline.create({
			sessionId: opts.streamId,
			cols,
			rows,
			queueMaxBytes: opts.queueMaxBytes,
			queueMaxEvents: opts.queueMaxEvents,
			snapshotScrollbackCap: opts.snapshotScrollbackCap,
			writeReply: (reply) => replies.push(reply),
			persistState: (snapshot) => snapshots.push(snapshot),
			createCore: (_options: GhosttyLiveOptions) => Promise.resolve(core),
			schedule: opts.scheduler.schedule,
			now: opts.clock.now,
			memory: () => ({ rssBytes: 1_000, heapUsedBytes: 500 }),
		});
		return new StreamHarness(opts.streamId, pipeline, core, mirror, snapshots, replies, opts.scheduler);
	}

	/** Feed one frame to both the pipeline and the mirror, tracking mirror high-water. */
	feed(frame: HarnessFrame): void {
		if (frame.kind === "output") {
			this.mirror.enqueueOutput(frame.bytes);
			this.pipeline.onOutput(frame.bytes);
		} else {
			this.mirror.enqueueResize(frame.cols, frame.rows);
			this.pipeline.onResize(frame.cols, frame.rows);
		}
		this.highWaterBytes = Math.max(this.highWaterBytes, this.mirror.pendingBytes);
		this.highWaterEvents = Math.max(this.highWaterEvents, this.mirror.pendingEvents);
	}

	feedAll(frames: HarnessFrame[]): void {
		for (const frame of frames) this.feed(frame);
	}

	/** Run every pending pipeline drain and drop the mirror's drained backlog in lockstep. */
	drain(): number {
		this.mirror.drain();
		return this.scheduler.runAll();
	}

	/** Force the pipeline to drain and persist without waiting on a scheduled task. */
	flush(): void {
		this.pipeline.flush();
	}

	get queueHighWaterBytes(): number {
		return this.highWaterBytes;
	}

	get queueHighWaterEvents(): number {
		return this.highWaterEvents;
	}

	budget(): StreamBudget {
		const snapshot = this.pipeline.snapshot();
		return {
			streamId: this.streamId,
			bytes: snapshot.ingested.bytes,
			frames: snapshot.ingested.frames,
			resizes: snapshot.ingested.resizes,
			replies: snapshot.ingested.replies,
			drains: snapshot.latency.drains,
			queueHighWaterBytes: this.highWaterBytes,
			queueHighWaterEvents: this.highWaterEvents,
			snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
			watermarkSeq: snapshot.watermarkSeq,
			overflow: snapshot.health.overflow,
			health: snapshot.health.status,
		};
	}

	dispose(): void {
		this.pipeline.dispose();
	}
}

export interface MultiStreamResult {
	streamCount: number;
	budgets: StreamBudget[];
	totalBytes: number;
	totalFrames: number;
	maxQueueHighWaterBytes: number;
	maxSnapshotBytes: number;
}

/** Fold per-stream budgets into a fleet-level rollup for the multi-stream scenarios. */
export function aggregate(streamCount: number, budgets: StreamBudget[]): MultiStreamResult {
	return {
		streamCount,
		budgets,
		totalBytes: budgets.reduce((sum, b) => sum + b.bytes, 0),
		totalFrames: budgets.reduce((sum, b) => sum + b.frames, 0),
		maxQueueHighWaterBytes: budgets.reduce((max, b) => Math.max(max, b.queueHighWaterBytes), 0),
		maxSnapshotBytes: budgets.reduce((max, b) => Math.max(max, b.snapshotBytes), 0),
	};
}
