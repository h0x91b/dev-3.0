/**
 * Load/budget harness over the real native parser + resync primitives.
 *
 * Each StreamHarness drives ONE real LiveParserPipeline (with a fake WASM core
 * injected through the pipeline's own `createCore` seam — the only fake). Since
 * seq 1284 the pipeline publishes its own queue / persistence / resync counters,
 * so the harness reads the production primitives directly; the mirror queue that
 * previously approximated queue depth is gone.
 *
 * The harness measures only what the public primitives expose: ingest totals
 * (bytes/frames/resizes/replies), drain iterations, watermark, queue high-water
 * and pressure, snapshot write/skip/byte accounting, health/overflow verdict, and
 * the serialized snapshot size. Nothing here touches a PTY, child process,
 * socket, filesystem, or real clock.
 */

import type { GhosttyLiveOptions, LiveParserCore, NativeSemanticState, NativeTextProjection } from "../ghostty-live";
import { LiveParserPipeline, type ParserPersistenceCounters, type ParserResyncCounters } from "../live-parser";
import type { ParserQueueOverflow, ParserQueuePressure } from "../parser-queue";
import type { ParserHealthStatus, ParserStateSnapshot } from "../parser-state";
import { SteppingClock, DeterministicScheduler, ManualTimers } from "./clock";
import type { HarnessFrame } from "./generators";
import { buildSemanticState } from "./semantic-state";

const DSR_MARKER = "\x1b[6n";
const decoder = new TextDecoder();

/** Fake parser core: counts ingest, answers one reply per DSR query, emits a valid state. */
export class BudgetCore implements LiveParserCore {
	ingestedBytes = 0;
	ingestedFrames = 0;
	disposed = false;
	/** Mutate to make the next inspected screen differ byte-wise (identical-skip). */
	title = "dev3-load-budget";
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
			title: this.title,
		});
	}

	project(scrollbackCap: number): NativeTextProjection {
		const state = this.inspect(scrollbackCap);
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

export interface StreamBudget {
	streamId: string;
	bytes: number;
	frames: number;
	resizes: number;
	replies: number;
	drains: number;
	queueHighWaterBytes: number;
	queueHighWaterEvents: number;
	queuePressure: ParserQueuePressure;
	slowConsumerEpisodes: number;
	snapshotBytes: number;
	persistence: ParserPersistenceCounters;
	resync: ParserResyncCounters;
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
	persistDebounceMs?: number;
	persistMinIntervalMs?: number;
}

export class StreamHarness {
	private constructor(
		readonly streamId: string,
		readonly pipeline: LiveParserPipeline,
		readonly core: BudgetCore,
		readonly snapshots: ParserStateSnapshot[],
		readonly replies: string[],
		readonly timers: ManualTimers,
		private readonly scheduler: DeterministicScheduler,
	) {}

	static async create(opts: StreamHarnessOptions): Promise<StreamHarness> {
		const cols = opts.cols ?? 80;
		const rows = opts.rows ?? 24;
		const core = new BudgetCore(cols, rows, opts.scrollbackLength ?? 0);
		const snapshots: ParserStateSnapshot[] = [];
		const replies: string[] = [];
		const timers = new ManualTimers();
		const pipeline = await LiveParserPipeline.create({
			sessionId: opts.streamId,
			cols,
			rows,
			queueMaxBytes: opts.queueMaxBytes,
			queueMaxEvents: opts.queueMaxEvents,
			snapshotScrollbackCap: opts.snapshotScrollbackCap,
			persistDebounceMs: opts.persistDebounceMs,
			persistMinIntervalMs: opts.persistMinIntervalMs,
			writeReply: (reply) => replies.push(reply),
			persistState: (snapshot) => {
				snapshots.push(snapshot);
			},
			createCore: (_options: GhosttyLiveOptions) => Promise.resolve(core),
			schedule: opts.scheduler.schedule,
			setTimer: timers.set,
			clearTimer: timers.clear,
			now: opts.clock.now,
			memory: () => ({ rssBytes: 1_000, heapUsedBytes: 500 }),
		});
		return new StreamHarness(opts.streamId, pipeline, core, snapshots, replies, timers, opts.scheduler);
	}

	feed(frame: HarnessFrame): void {
		if (frame.kind === "output") this.pipeline.onOutput(frame.bytes);
		else this.pipeline.onResize(frame.cols, frame.rows);
	}

	feedAll(frames: HarnessFrame[]): void {
		for (const frame of frames) this.feed(frame);
	}

	/** Run every pending pipeline drain; returns the number of drains executed. */
	drain(): number {
		return this.scheduler.runAll();
	}

	/** Fire every armed persistence timer; returns the number of writes attempted. */
	runPersistTimers(): number {
		return this.timers.runAll();
	}

	/** Force the pipeline to drain and persist without waiting on a scheduled task. */
	flush(): void {
		this.pipeline.flush();
	}

	get queueHighWaterBytes(): number {
		return this.pipeline.queueCounters().highWaterBytes;
	}

	get queueHighWaterEvents(): number {
		return this.pipeline.queueCounters().highWaterEvents;
	}

	budget(): StreamBudget {
		const snapshot = this.pipeline.snapshot();
		const queue = this.pipeline.queueCounters();
		return {
			streamId: this.streamId,
			bytes: snapshot.ingested.bytes,
			frames: snapshot.ingested.frames,
			resizes: snapshot.ingested.resizes,
			replies: snapshot.ingested.replies,
			drains: snapshot.latency.drains,
			queueHighWaterBytes: queue.highWaterBytes,
			queueHighWaterEvents: queue.highWaterEvents,
			queuePressure: queue.pressure,
			slowConsumerEpisodes: queue.slowConsumerEpisodes,
			snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
			persistence: this.pipeline.persistenceCounters(),
			resync: this.pipeline.resyncCounters(),
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
	totalWrites: number;
	totalSkippedWrites: number;
	totalPersistedBytes: number;
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
		totalWrites: budgets.reduce((sum, b) => sum + b.persistence.writes, 0),
		totalSkippedWrites: budgets.reduce((sum, b) => sum + b.persistence.skippedIdentical, 0),
		totalPersistedBytes: budgets.reduce((sum, b) => sum + b.persistence.totalBytes, 0),
	};
}
