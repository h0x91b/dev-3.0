/**
 * Deferred live-parser pipeline for the native-session host (seq 1228).
 *
 * CALLBACK BOUNDARY (the whole point): `onOutput`/`onResize` are the ONLY
 * methods callable from inside the Bun.Terminal data callback, and they do
 * nothing but bounded enqueueing + scheduling. Ghostty WASM runs exclusively in
 * `drainNow`, scheduled as a normal event-loop macrotask — never inside the
 * callback, where Bun 1.3.14 on Windows returns a negative WASM allocation
 * pointer (decision 146; regression-probe.ts preserves the reproduction).
 *
 * Parser-generated terminal replies (DSR/DA/mode reports) are drained after
 * each ingest and written back to the same PTY via the injected `writeReply`,
 * so interactive TUIs keep operating. Replies are input to the shell — the
 * parser only ever sees PTY *output* — so no feedback loop is possible, and
 * Ghostty emits exactly one reply per query (asserted in tests and E2E).
 *
 * FAILURE CONTAINMENT: any parser error flips the pipeline to a terminal
 * `failed` state (recorded in the snapshot) and the host keeps serving raw
 * bytes. Queue overflow flips it to `overflowed` — bounded and explicit, never
 * a silently corrupt screen. Neither state ever throws into the host.
 *
 * PERSISTENCE BUDGET (seq 1284): the semantic snapshot is MiB-scale, so writes
 * are debounced, capped at one per `persistMinIntervalMs`, skipped when the
 * semantic payload is byte-identical, and limited to one in flight per pane —
 * a later dirty update coalesces into a single re-armed write instead of
 * stacking promises. `queueCounters` / `persistenceCounters` / `resyncCounters`
 * expose the resulting pressure read-only, without leaking queue internals.
 */

import {
	GhosttyLiveParser,
	type GhosttyLiveOptions,
	type LiveParserCore,
	type NativeSemanticState,
	type NativeTextProjection,
	LIVE_PARSER_ID,
} from "./ghostty-live";
import {
	DEFAULT_PARSER_QUEUE_MAX_BYTES,
	DEFAULT_PARSER_QUEUE_MAX_EVENTS,
	DEFAULT_QUEUE_SLOW_CONSUMER_RATIO,
	ParserEventQueue,
	type ParserQueueCounters,
} from "./parser-queue";
import {
	PARSER_STATE_SCHEMA,
	PARSER_STATE_VERSION,
	type ParserHealthStatus,
	type ParserMemoryStats,
	type ParserStateSnapshot,
} from "./parser-state";

export const DEFAULT_SNAPSHOT_SCROLLBACK_CAP = 200;
export const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
/**
 * Cadence CEILING for snapshot persistence: at most one write per pane per
 * second. The debounce alone allowed ~4 writes/s of a multi-MiB semantic
 * snapshot (measured: ~1.6 MiB at 80×24 and ~4.7 MiB at 200×60 with a full
 * 200-line scrollback — see native-terminal-load-budget/FINDINGS.md), i.e. up
 * to ~19 MiB/s of disk churn per busy wide pane. See decision 169.
 */
export const DEFAULT_PERSIST_MIN_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_REPLIES_PER_DRAIN = 64;
const LATENCY_RING_SIZE = 512;

/** Snapshot-persistence accounting, exposed read-only for diagnostics. */
export interface ParserPersistenceCounters {
	/** Writes actually handed to `persistState`. */
	writes: number;
	/** Write attempts skipped because the semantic snapshot was byte-identical. */
	skippedIdentical: number;
	/** Dirty updates folded into a later write because one was already in flight. */
	coalesced: number;
	/** Write attempts that threw or rejected — contained, never fatal. */
	failures: number;
	/** Serialized size of the semantic payload of the last write (dominant term). */
	lastBytes: number;
	/** Peak serialized semantic payload observed. */
	maxBytes: number;
	/** Cumulative serialized semantic bytes written. */
	totalBytes: number;
	/** Injected-clock timestamp of the last completed write, or null. */
	lastWriteAtMs: number | null;
	/** A write is currently outstanding (async `persistState` only). */
	inFlight: boolean;
	minIntervalMs: number;
}

/** Sequence-gap accounting — the resync signal the journal replay consumes. */
export interface ParserResyncCounters {
	/** Number of discontinuities observed in the ingested sequence. */
	gaps: number;
	/** Total sequence numbers that never reached the parser. */
	missedSeqs: number;
	/** Watermark at which the most recent gap was observed, or null. */
	lastGapAtSeq: number | null;
}

export interface LiveParserPipelineOptions {
	sessionId: string;
	cols: number;
	rows: number;
	/** Ghostty scrollback retained in the live core (bounded memory). */
	scrollbackLimit?: number;
	/** Scrollback lines persisted into the snapshot (bounded state file). */
	snapshotScrollbackCap?: number;
	queueMaxBytes?: number;
	queueMaxEvents?: number;
	/** Backlog fraction of either cap at which pressure reports `slow-consumer`. */
	queueSlowConsumerRatio?: number;
	persistDebounceMs?: number;
	/** Cadence ceiling — minimum wall time between two snapshot writes. */
	persistMinIntervalMs?: number;
	/**
	 * Skip a write whose semantic payload is byte-identical (default true).
	 * Only the load probe turns it off, to measure the pre-policy baseline.
	 */
	persistSkipIdentical?: boolean;
	maxRepliesPerDrain?: number;
	/** Write one parser-generated reply back to the SAME PTY. Must not throw. */
	writeReply: (reply: string) => void;
	/**
	 * Publish the per-cell snapshot. INDEPENDENT of {@link persistProjection}:
	 * either, both, or neither may be set. Failures are contained, and one write is
	 * ever in flight for this sink.
	 */
	persistState?: (snapshot: ParserStateSnapshot) => void | Promise<void>;
	/**
	 * Publish the compact plain-text projection. Set on its own, the per-cell state
	 * is never built OR serialised — that JSON, not the parsing, is the cost.
	 */
	persistProjection?: (projection: LiveParserProjection) => void | Promise<void>;
	/** Called only when the set of durably readable sinks actually changes. */
	onSinkReadinessChange?: () => void | Promise<void>;
	/** Test seams — production uses the defaults. */
	createCore?: (options: GhosttyLiveOptions) => Promise<LiveParserCore>;
	schedule?: (fn: () => void) => void;
	/** Delayed-timer seam for the persistence debounce/cadence. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	now?: () => number;
	memory?: () => ParserMemoryStats;
	/** Test-only injected fault (DEV3_NATIVE_SESSION_PARSER_FAULT). */
	fault?: "ingest" | null;
}

const defaultSchedule = (fn: () => void): void => {
	if (typeof setImmediate === "function") setImmediate(fn);
	else setTimeout(fn, 0);
};

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
	const handle = setTimeout(fn, ms);
	handle.unref?.();
	return handle;
};

const defaultClearTimer = (handle: unknown): void => {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
};

const defaultMemory = (): ParserMemoryStats => {
	const usage = process.memoryUsage();
	return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
};

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index];
}

/** What the pipeline hands a projection consumer: the rows plus its own health. */
export interface LiveParserProjection {
	sessionId: string;
	/** When this content changed — preserved across a forced durable rewrite. */
	updatedAt: string;
	watermarkSeq: number;
	activeBuffer: "normal" | "alternate";
	cols: number;
	rows: number;
	viewport: string[];
	history: string[];
	historyTotal: number;
	status: ParserHealthStatus;
	error?: string;
	droppedBytes: number;
	droppedChunks: number;
	resyncGaps: number;
}

/**
 * Everything a reader can observe in a published record, EXCEPT the timestamp,
 * producer, and watermark. Identical rows with a resize, a new scrollback depth,
 * or a health transition are NOT identical writes.
 */
function projectionIdentity(projection: LiveParserProjection): string {
	return [
		projection.status,
		projection.error ?? "",
		projection.activeBuffer,
		projection.cols,
		projection.rows,
		projection.historyTotal,
		projection.droppedBytes,
		projection.droppedChunks,
		projection.resyncGaps,
		projection.viewport.join("\n"),
		projection.history.join("\n"),
	].join("\u0000");
}

/** Which artifact a sink publishes. */
export const CAPTURE_SINKS = ["semantic", "compact"] as const;
export type CaptureSinkName = (typeof CAPTURE_SINKS)[number];

/**
 * `disabled` — not selected. `pending` — selected, nothing durable yet.
 * `ready` — a readable artifact exists. `backingOff` — a failed write will retry.
 * Only `ready` may advertise a capability.
 */
export type CaptureSinkState = "disabled" | "pending" | "ready" | "backingOff";

interface SinkCandidate {
	generation: number;
	identity: string;
	updatedAt: string;
	bytes: number;
	write: () => void | Promise<void>;
}

interface SinkLastGood {
	identity: string;
	updatedAt: string;
}

type SinkPublication =
	| { kind: "disabled" }
	| { kind: "pending"; candidate: SinkCandidate; lastGood?: SinkLastGood }
	| { kind: "ready"; lastGood: SinkLastGood }
	| { kind: "backingOff"; candidate: SinkCandidate; lastGood?: SinkLastGood; retryAtMs: number; attempt: number };

type SinkPublicationEvent =
	| { type: "candidate"; candidate: SinkCandidate }
	| { type: "succeeded"; candidate: SinkCandidate }
	| { type: "failed"; candidate: SinkCandidate; retryAtMs: number };

function lastGoodOf(state: SinkPublication): SinkLastGood | undefined {
	return state.kind === "ready" ? state.lastGood : state.kind === "pending" || state.kind === "backingOff" ? state.lastGood : undefined;
}

function candidateOf(state: SinkPublication): SinkCandidate | undefined {
	return state.kind === "pending" || state.kind === "backingOff" ? state.candidate : undefined;
}

function reduceSinkPublication(state: SinkPublication, event: SinkPublicationEvent): SinkPublication {
	const lastGood = lastGoodOf(state);
	if (event.type === "candidate") return { kind: "pending", candidate: event.candidate, ...(lastGood ? { lastGood } : {}) };
	const current = candidateOf(state);
	if (event.type === "succeeded") {
		const published = { identity: event.candidate.identity, updatedAt: event.candidate.updatedAt };
		if (current && current.generation !== event.candidate.generation) {
			return { kind: "pending", candidate: current, lastGood: published };
		}
		return { kind: "ready", lastGood: published };
	}
	if (current && current.generation !== event.candidate.generation) {
		return { kind: "pending", candidate: current, ...(lastGood ? { lastGood } : {}) };
	}
	const candidate = current ?? event.candidate;
	const previousAttempt = state.kind === "backingOff" ? state.attempt : 0;
	return {
		kind: "backingOff",
		candidate,
		...(lastGood ? { lastGood } : {}),
		retryAtMs: event.retryAtMs,
		attempt: previousAttempt + 1,
	};
}

/** Ceiling on the retry backoff, so a broken sink neither spins nor gives up. */
const SINK_RETRY_MAX_MS = 30_000;

export class LiveParserPipeline {
	private readonly queue: ParserEventQueue;
	private status: ParserHealthStatus = "live";
	private failureError: string | undefined;
	private drainScheduled = false;
	private disposed = false;
	private disposing = false;
	private lifecycleGeneration = 1;
	private disposePromise: Promise<void> | null = null;
	private watermarkSeq = 0;
	private readonly ingested = { frames: 0, bytes: 0, resizes: 0, replies: 0 };
	private readonly durations: number[] = [];
	private drains = 0;
	private totalMs = 0;
	private maxMs = 0;
	private persistTimer: unknown = null;
	private lastState: NativeSemanticState | null = null;
	private readonly resync: ParserResyncCounters = { gaps: 0, missedSeqs: 0, lastGapAtSeq: null };
	private readonly persist = {
		writes: 0,
		skippedIdentical: 0,
		coalesced: 0,
		failures: 0,
		lastBytes: 0,
		maxBytes: 0,
		totalBytes: 0,
		lastWriteAtMs: null as number | null,
	};
	/** Serialized semantic payload of the last write — the identical-skip key. */
	private lastProjection: NativeTextProjection | null = null;
	private coreReleased = false;
	private readonly sinks: Record<CaptureSinkName, SinkPublication> = {
		semantic: { kind: "disabled" },
		compact: { kind: "disabled" },
	};
	private readonly sinkInFlight: Record<CaptureSinkName, Promise<void> | null> = {
		semantic: null,
		compact: null,
	};
	private readonly sinkRetryTimers: Record<CaptureSinkName, unknown | null> = {
		semantic: null,
		compact: null,
	};
	private readonly readinessSettlements = new Set<Promise<void>>();
	private candidateGeneration = 0;

	private constructor(
		private readonly core: LiveParserCore,
		private readonly opts: LiveParserPipelineOptions,
	) {
		this.queue = new ParserEventQueue(
			opts.queueMaxBytes ?? DEFAULT_PARSER_QUEUE_MAX_BYTES,
			opts.queueMaxEvents ?? DEFAULT_PARSER_QUEUE_MAX_EVENTS,
			opts.queueSlowConsumerRatio ?? DEFAULT_QUEUE_SLOW_CONSUMER_RATIO,
		);
	}

	/** Load the parser core OUTSIDE any terminal callback (host boot path). */
	static async create(opts: LiveParserPipelineOptions): Promise<LiveParserPipeline> {
		const createCore = opts.createCore ?? ((o: GhosttyLiveOptions) => GhosttyLiveParser.create(o));
		const core = await createCore({
			cols: opts.cols,
			rows: opts.rows,
			scrollbackLimit: opts.scrollbackLimit ?? 1000,
		});
		const pipeline = new LiveParserPipeline(core, opts);
		return pipeline;
	}

	/** Callback-safe: bounded enqueue + macrotask schedule. NO parsing here. */
	onOutput(bytes: Uint8Array): void {
		if (this.disposed || this.disposing || this.status !== "live") return;
		this.queue.enqueueOutput(bytes);
		this.scheduleDrain();
	}

	/** Callback-safe: records the resize at its real position in output order. */
	onResize(cols: number, rows: number): void {
		if (this.disposed || this.disposing || this.status !== "live") return;
		this.queue.enqueueResize(cols, rows);
		this.scheduleDrain();
	}

	private scheduleDrain(): void {
		if (this.drainScheduled) return;
		this.drainScheduled = true;
		const generation = this.lifecycleGeneration;
		(this.opts.schedule ?? defaultSchedule)(() => {
			if (this.disposed || generation !== this.lifecycleGeneration) return;
			this.drainScheduled = false;
			this.drainNow();
		});
	}

	/** The ONLY place Ghostty runs. Ordinary event-loop task, never the callback. */
	drainNow(): void {
		if (this.disposed || this.status !== "live") return;
		if (this.queue.overflowed) {
			this.enterTerminalState("overflowed");
			return;
		}
		const events = this.queue.drain();
		if (events.length === 0) return;
		const now = this.opts.now ?? Date.now;
		const started = now();
		try {
			if (this.opts.fault === "ingest") {
				throw new Error("injected parser fault (DEV3_NATIVE_SESSION_PARSER_FAULT=ingest)");
			}
			for (const event of events) {
				if (event.seq > this.watermarkSeq + 1) {
					this.resync.gaps++;
					this.resync.missedSeqs += event.seq - this.watermarkSeq - 1;
					this.resync.lastGapAtSeq = event.seq;
				}
				if (event.kind === "output") {
					this.core.ingest(event.bytes);
					this.ingested.frames++;
					this.ingested.bytes += event.bytes.length;
				} else {
					this.core.resize(event.cols, event.rows);
					this.ingested.resizes++;
				}
				this.watermarkSeq = event.seq;
			}
			const replies = this.core.readResponses();
			const cap = this.opts.maxRepliesPerDrain ?? DEFAULT_MAX_REPLIES_PER_DRAIN;
			for (const reply of replies.slice(0, cap)) {
				this.ingested.replies++;
				try {
					this.opts.writeReply(reply);
				} catch {
					// PTY already closed — the reply is moot, the parser stays healthy
				}
			}
		} catch (err) {
			this.failureError = err instanceof Error ? err.message : String(err);
			this.enterTerminalState("failed");
			return;
		}
		const elapsed = now() - started;
		this.drains++;
		this.totalMs += elapsed;
		if (elapsed > this.maxMs) this.maxMs = elapsed;
		this.durations.push(elapsed);
		if (this.durations.length > LATENCY_RING_SIZE) this.durations.shift();
		this.schedulePersist();
	}

	/**
	 * Overflow/failure end state: parsing stops and the verdict is persisted once.
	 * A FAILED parser is fatal — it will never produce another screen — so its
	 * Ghostty/WASM instance is released here instead of being held until session
	 * teardown. Overflow stays alive: its last good screen is still the truth, and
	 * it can be read for as long as the pane lives.
	 */
	private enterTerminalState(status: ParserHealthStatus): void {
		this.status = status;
		this.queue.clear();
		this.persistNow(true);
		if (status === "failed") this.releaseCore();
	}

	/**
	 * A fatal parser error, wherever it surfaces. Parsing stops and the core is
	 * released here too — a failure found while building a screen is just as final
	 * as one found while ingesting, and holding WASM for a parser that will never
	 * produce another screen is pure waste.
	 */
	private markFailed(err: unknown): void {
		this.failureError = err instanceof Error ? err.message : String(err);
		this.status = "failed";
		this.queue.clear();
		this.releaseCore();
	}

	/** Free the parser core once, keeping the last published verdict readable. */
	private releaseCore(): void {
		if (this.coreReleased) return;
		this.coreReleased = true;
		try {
			this.core.dispose();
		} catch {
			// a core that cannot be freed must not take the host down
		}
	}

	/**
	 * Arm the debounce, pushed out so two writes are never closer together than
	 * the cadence ceiling. Re-arming while armed is a no-op — the single timer
	 * always persists the LATEST state, so dirty updates coalesce for free.
	 */
	private schedulePersist(): void {
		if (this.persistTimer || this.disposed || this.disposing) return;
		const debounce = this.opts.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
		const minInterval = this.opts.persistMinIntervalMs ?? DEFAULT_PERSIST_MIN_INTERVAL_MS;
		const sinceLast =
			this.persist.lastWriteAtMs === null ? Number.POSITIVE_INFINITY : (this.opts.now ?? Date.now)() - this.persist.lastWriteAtMs;
		const delay = Math.max(debounce, minInterval - sinceLast);
		const generation = this.lifecycleGeneration;
		this.persistTimer = (this.opts.setTimer ?? defaultSetTimer)(() => {
			if (this.disposed || this.disposing || generation !== this.lifecycleGeneration) return;
			this.persistTimer = null;
			this.persistNow();
		}, delay);
	}

	private cancelPersistTimer(): void {
		if (this.persistTimer === null) return;
		(this.opts.clearTimer ?? defaultClearTimer)(this.persistTimer);
		this.persistTimer = null;
	}

	/**
	 * One sink's publication state. `ready` is the only state that may advertise a
	 * capability: a caller must never see a surface with nothing readable behind it.
	 */
	sinkState(sink: CaptureSinkName): CaptureSinkState {
		const state = this.sinks[sink];
		if (state.kind === "disabled") return "disabled";
		if (state.kind === "ready") return "ready";
		if (state.kind === "backingOff") return state.lastGood ? "ready" : "backingOff";
		return state.lastGood ? "ready" : "pending";
	}

	private prepareSelectedCandidates(force: boolean): void {
		const nowMs = (this.opts.now ?? Date.now)();
		if (this.opts.persistState) this.prepareCandidate("semantic", nowMs, force);
		if (this.opts.persistProjection) this.prepareCandidate("compact", nowMs, force);
	}

	private prepareCandidate(sink: CaptureSinkName, nowMs: number, force: boolean): void {
		const state = this.sinks[sink];
		let identity: string;
		let bytes: number;
		let writeWithTimestamp: (updatedAt: string) => void | Promise<void>;
		if (sink === "semantic") {
			if (!this.opts.persistState) return;
			const snapshot = this.snapshot();
			identity = `${this.status}|${JSON.stringify(snapshot.state)}`;
			bytes = Buffer.byteLength(identity, "utf8");
			writeWithTimestamp = (updatedAt) => this.opts.persistState?.({ ...snapshot, updatedAt });
		} else {
			if (!this.opts.persistProjection) return;
			const projection = this.projection();
			identity = projectionIdentity(projection);
			bytes = Buffer.byteLength(identity, "utf8");
			writeWithTimestamp = (updatedAt) => this.opts.persistProjection?.({ ...projection, updatedAt });
		}
		const existingCandidate = candidateOf(state);
		const lastGood = lastGoodOf(state);
		if (!force && existingCandidate?.identity === identity) return;
		if (!force && lastGood?.identity === identity && this.opts.persistSkipIdentical !== false) {
			this.persist.skippedIdentical++;
			return;
		}
		const updatedAt =
			existingCandidate?.identity === identity
				? existingCandidate.updatedAt
				: lastGood?.identity === identity
					? lastGood.updatedAt
					: new Date(nowMs).toISOString();
		const candidate: SinkCandidate = {
			generation: ++this.candidateGeneration,
			identity,
			updatedAt,
			bytes,
			write: () => writeWithTimestamp(updatedAt),
		};
		this.sinks[sink] = reduceSinkPublication(state, { type: "candidate", candidate });
	}

	private persistNow(force = false): void {
		if (this.disposed) return;
		this.prepareSelectedCandidates(force);
		for (const sink of CAPTURE_SINKS) this.startSinkAttempt(sink, force);
	}

	private startSinkAttempt(sink: CaptureSinkName, force: boolean): void {
		if (this.sinkInFlight[sink]) {
			this.persist.coalesced++;
			return;
		}
		const state = this.sinks[sink];
		const candidate = candidateOf(state);
		if (!candidate) return;
		if (state.kind === "backingOff" && !force && (this.opts.now ?? Date.now)() < state.retryAtMs) {
			this.scheduleSinkRetry(sink, state);
			return;
		}
		this.cancelSinkRetry(sink);
		const lifecycleGeneration = this.lifecycleGeneration;
		this.persist.writes++;
		this.persist.lastBytes = candidate.bytes;
		this.persist.totalBytes += candidate.bytes;
		if (candidate.bytes > this.persist.maxBytes) this.persist.maxBytes = candidate.bytes;
		this.persist.lastWriteAtMs = (this.opts.now ?? Date.now)();

		const succeeded = (): void => this.settleSink(sink, candidate, true, lifecycleGeneration);
		const failed = (): void => this.settleSink(sink, candidate, false, lifecycleGeneration);
		let result: void | Promise<void>;
		try {
			result = candidate.write();
		} catch {
			failed();
			return;
		}
		if (!result || typeof (result as Promise<void>).then !== "function") {
			succeeded();
			return;
		}
		let settlement: Promise<void>;
		settlement = Promise.resolve(result)
			.then(succeeded, failed)
			.finally(() => {
				if (this.sinkInFlight[sink] === settlement) this.sinkInFlight[sink] = null;
				if (this.disposed || lifecycleGeneration !== this.lifecycleGeneration) return;
				const pending = candidateOf(this.sinks[sink]);
				if (pending && pending.generation !== candidate.generation) this.schedulePersist();
			});
		this.sinkInFlight[sink] = settlement;
	}

	private settleSink(
		sink: CaptureSinkName,
		candidate: SinkCandidate,
		succeeded: boolean,
		lifecycleGeneration: number,
	): void {
		if (this.disposed || lifecycleGeneration !== this.lifecycleGeneration) return;
		const beforeReady = this.sinkState(sink) === "ready";
		if (succeeded) {
			this.sinks[sink] = reduceSinkPublication(this.sinks[sink], { type: "succeeded", candidate });
		} else {
			this.persist.failures++;
			const previousAttempt = this.sinks[sink].kind === "backingOff" ? this.sinks[sink].attempt : 0;
			const retryAtMs = (this.opts.now ?? Date.now)() + this.retryDelayMs(previousAttempt + 1);
			this.sinks[sink] = reduceSinkPublication(this.sinks[sink], { type: "failed", candidate, retryAtMs });
			const next = this.sinks[sink];
			if (next.kind === "backingOff") this.scheduleSinkRetry(sink, next);
		}
		const afterReady = this.sinkState(sink) === "ready";
		if (beforeReady !== afterReady) this.notifyReadinessChanged(lifecycleGeneration);
	}

	private notifyReadinessChanged(lifecycleGeneration: number): void {
		if (!this.opts.onSinkReadinessChange || this.disposed || lifecycleGeneration !== this.lifecycleGeneration) return;
		let result: void | Promise<void>;
		try {
			result = this.opts.onSinkReadinessChange();
		} catch {
			return;
		}
		if (!result || typeof (result as Promise<void>).then !== "function") return;
		let settlement: Promise<void>;
		settlement = Promise.resolve(result)
			.catch(() => {})
			.finally(() => this.readinessSettlements.delete(settlement));
		this.readinessSettlements.add(settlement);
	}

	private scheduleSinkRetry(sink: CaptureSinkName, state: Extract<SinkPublication, { kind: "backingOff" }>): void {
		if (this.sinkRetryTimers[sink] !== null || this.disposed || this.disposing) return;
		const generation = this.lifecycleGeneration;
		const candidateGeneration = state.candidate.generation;
		const retryAtMs = state.retryAtMs;
		this.sinkRetryTimers[sink] = (this.opts.setTimer ?? defaultSetTimer)(() => {
			this.sinkRetryTimers[sink] = null;
			if (this.disposed || this.disposing || generation !== this.lifecycleGeneration) return;
			const current = this.sinks[sink];
			if (current.kind !== "backingOff" || current.candidate.generation !== candidateGeneration) return;
			// The timer firing is the due event. Test schedulers deliberately do not
			// advance the injected clock when they execute a delayed callback.
			this.startSinkAttempt(sink, true);
		}, Math.max(0, retryAtMs - (this.opts.now ?? Date.now)()));
	}

	private cancelSinkRetry(sink: CaptureSinkName): void {
		const timer = this.sinkRetryTimers[sink];
		if (timer === null) return;
		(this.opts.clearTimer ?? defaultClearTimer)(timer);
		this.sinkRetryTimers[sink] = null;
	}

	/** Bounded exponential backoff, so a permanently broken sink cannot spin. */
	private retryDelayMs(failures: number): number {
		const base = this.opts.persistMinIntervalMs ?? DEFAULT_PERSIST_MIN_INTERVAL_MS;
		return Math.min(base * 2 ** Math.min(failures - 1, 5), SINK_RETRY_MAX_MS);
	}

	/**
	 * Build the bounded plain-text projection. Same failure containment as
	 * {@link snapshot}: a projection error degrades this pipeline to `failed`
	 * rather than taking the host down, and the last good rows are republished.
	 */
	projection(): LiveParserProjection {
		if (this.status === "live") {
			try {
				this.lastProjection = this.core.project(this.opts.snapshotScrollbackCap ?? DEFAULT_SNAPSHOT_SCROLLBACK_CAP);
			} catch (err) {
				this.markFailed(err);
			}
		}
		const projected = this.lastProjection;
		const resync = this.resyncCounters();
		return {
			sessionId: this.opts.sessionId,
			// Replaced by the publication plan; a projection built outside one is "now".
			updatedAt: new Date((this.opts.now ?? Date.now)()).toISOString(),
			watermarkSeq: this.watermarkSeq,
			activeBuffer: projected?.activeBuffer ?? "normal",
			cols: projected?.dimensions.cols ?? this.opts.cols,
			rows: projected?.dimensions.rows ?? this.opts.rows,
			viewport: projected?.viewport ?? [],
			history: projected?.history ?? [],
			historyTotal: projected?.historyTotal ?? 0,
			status: this.status,
			...(this.failureError ? { error: this.failureError } : {}),
			droppedBytes: this.queue.overflow.droppedBytes,
			droppedChunks: this.queue.overflow.droppedChunks,
			resyncGaps: resync.gaps,
		};
	}

	/** Build the bounded snapshot; inspection errors degrade to the last state. */
	snapshot(): ParserStateSnapshot {
		if (this.status === "live") {
			try {
				this.lastState = this.core.inspect(this.opts.snapshotScrollbackCap ?? DEFAULT_SNAPSHOT_SCROLLBACK_CAP);
			} catch (err) {
				this.markFailed(err);
			}
		}
		const sorted = [...this.durations].sort((a, b) => a - b);
		return {
			schema: PARSER_STATE_SCHEMA,
			version: PARSER_STATE_VERSION,
			parser: LIVE_PARSER_ID,
			sessionId: this.opts.sessionId,
			watermarkSeq: this.watermarkSeq,
			health: {
				status: this.status,
				...(this.failureError ? { error: this.failureError } : {}),
				overflow: this.queue.overflow,
			},
			ingested: { ...this.ingested },
			latency: {
				drains: this.drains,
				totalMs: this.totalMs,
				maxMs: this.maxMs,
				p50Ms: percentile(sorted, 0.5),
				p95Ms: percentile(sorted, 0.95),
			},
			memory: (this.opts.memory ?? defaultMemory)(),
			state: this.lastState,
			updatedAt: new Date().toISOString(),
		};
	}

	/**
	 * Force-drain pending events and persist immediately (detach/shutdown path).
	 * Bypasses both the cadence ceiling and the identical-skip so the latest
	 * state — including final counters — is always on disk after cleanup.
	 */
	async flushAndWait(): Promise<void> {
		if (this.disposed) return;
		this.drainNow();
		this.cancelPersistTimer(); // the drain may have re-armed the debounce
		for (const sink of CAPTURE_SINKS) this.cancelSinkRetry(sink);
		this.persistNow(true);
		const targets: Partial<Record<CaptureSinkName, number>> = {};
		for (const sink of CAPTURE_SINKS) {
			const candidate = candidateOf(this.sinks[sink]);
			if (candidate) targets[sink] = candidate.generation;
		}
		for (;;) {
			const inFlight = CAPTURE_SINKS.map((sink) => this.sinkInFlight[sink]).filter(
				(value): value is Promise<void> => value !== null,
			);
			if (inFlight.length > 0) await Promise.allSettled(inFlight);
			let started = false;
			for (const sink of CAPTURE_SINKS) {
				const target = targets[sink];
				const state = this.sinks[sink];
				const candidate = candidateOf(state);
				if (target !== undefined && state.kind === "pending" && candidate?.generation === target && !this.sinkInFlight[sink]) {
					this.startSinkAttempt(sink, true);
					started = true;
				}
			}
			if (started) continue;
			if (this.readinessSettlements.size > 0) await Promise.allSettled([...this.readinessSettlements]);
			return;
		}
	}

	get healthStatus(): ParserHealthStatus {
		return this.status;
	}

	/** Read-only live queue depth, high-water marks, caps, and pressure verdict. */
	queueCounters(): ParserQueueCounters {
		return this.queue.counters();
	}

	/** Read-only snapshot-persistence accounting (writes, skips, bytes, cadence). */
	persistenceCounters(): ParserPersistenceCounters {
		return {
			...this.persist,
			inFlight: CAPTURE_SINKS.some((sink) => this.sinkInFlight[sink] !== null),
			minIntervalMs: this.opts.persistMinIntervalMs ?? DEFAULT_PERSIST_MIN_INTERVAL_MS,
		};
	}

	/** Read-only sequence-gap accounting observed while ingesting. */
	resyncCounters(): ParserResyncCounters {
		return { ...this.resync };
	}

	disposeAndWait(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposing = true;
		this.disposePromise = (async () => {
			try {
				await this.flushAndWait();
			} finally {
				this.disposed = true;
				this.disposing = false;
				this.lifecycleGeneration++;
				this.cancelPersistTimer();
				for (const sink of CAPTURE_SINKS) this.cancelSinkRetry(sink);
				await Promise.allSettled(
					CAPTURE_SINKS.map((sink) => this.sinkInFlight[sink]).filter(
						(value): value is Promise<void> => value !== null,
					),
				);
				// A fatal failure may already have released Ghostty. Double-freeing its
				// uncleared WASM handle corrupts the heap, so all teardown goes through this.
				this.releaseCore();
			}
		})();
		return this.disposePromise;
	}
}
