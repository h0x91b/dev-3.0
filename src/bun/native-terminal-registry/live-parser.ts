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
	 * Persist a snapshot (atomic file write in the host). Failures are contained.
	 * May return a promise; only one write is ever in flight per pipeline.
	 */
	/**
	 * Publish the per-cell snapshot. INDEPENDENT of {@link persistProjection}:
	 * either, both, or neither may be set, and one being absent can never disable
	 * the other.
	 */
	persistState?: (snapshot: ParserStateSnapshot) => void | Promise<void>;
	/**
	 * Publish the compact plain-text projection. Set on its own, the per-cell state
	 * is never built OR serialised — that JSON, not the parsing, is the cost.
	 */
	persistProjection?: (projection: LiveParserProjection) => void | Promise<void>;
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
 * Everything a reader can observe in a published record, EXCEPT the timestamp and
 * the producer. Identical rows with a resize, a new scrollback depth, an advanced
 * watermark, or a health transition are NOT identical writes.
 */
function projectionIdentity(projection: LiveParserProjection): string {
	return [
		projection.status,
		projection.error ?? "",
		projection.activeBuffer,
		projection.cols,
		projection.rows,
		projection.historyTotal,
		projection.watermarkSeq,
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
 * `ready` — a readable artifact exists. `failed` — selected, tried, nothing durable.
 * Only `ready` may advertise a capability.
 */
export type CaptureSinkState = "disabled" | "pending" | "ready" | "failed";

interface SinkPublication {
	state: CaptureSinkState;
	/** Content identity of the last SUCCESSFUL publication. */
	identity: string | null;
	/** When that content changed, preserved across forced durable rewrites. */
	updatedAt: string | null;
	failures: number;
	retryAtMs: number | null;
}

/** Ceiling on the retry backoff, so a broken sink neither spins nor gives up. */
const SINK_RETRY_MAX_MS = 30_000;

export class LiveParserPipeline {
	private readonly queue: ParserEventQueue;
	private status: ParserHealthStatus = "live";
	private failureError: string | undefined;
	private drainScheduled = false;
	private disposed = false;
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
	private writeInFlight = false;
	private lastProjection: NativeTextProjection | null = null;
	private coreReleased = false;
	private readonly sinks: Record<CaptureSinkName, SinkPublication> = {
		semantic: { state: "disabled", identity: null, updatedAt: null, failures: 0, retryAtMs: null },
		compact: { state: "disabled", identity: null, updatedAt: null, failures: 0, retryAtMs: null },
	};
	/** Set once, from the sinks actually wired: selected but not yet durable. */
	markSelectedSinks(): void {
		if (this.opts.persistState) this.sinks.semantic.state = "pending";
		if (this.opts.persistProjection) this.sinks.compact.state = "pending";
	}
	/** A newer state is waiting for the in-flight write to settle. */
	private persistDirty = false;

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
		pipeline.markSelectedSinks();
		return pipeline;
	}

	/** Callback-safe: bounded enqueue + macrotask schedule. NO parsing here. */
	onOutput(bytes: Uint8Array): void {
		if (this.disposed || this.status !== "live") return;
		this.queue.enqueueOutput(bytes);
		this.scheduleDrain();
	}

	/** Callback-safe: records the resize at its real position in output order. */
	onResize(cols: number, rows: number): void {
		if (this.disposed || this.status !== "live") return;
		this.queue.enqueueResize(cols, rows);
		this.scheduleDrain();
	}

	private scheduleDrain(): void {
		if (this.drainScheduled) return;
		this.drainScheduled = true;
		(this.opts.schedule ?? defaultSchedule)(() => {
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
		if (this.persistTimer || this.disposed) return;
		const debounce = this.opts.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
		const minInterval = this.opts.persistMinIntervalMs ?? DEFAULT_PERSIST_MIN_INTERVAL_MS;
		const sinceLast =
			this.persist.lastWriteAtMs === null ? Number.POSITIVE_INFINITY : (this.opts.now ?? Date.now)() - this.persist.lastWriteAtMs;
		const delay = Math.max(debounce, minInterval - sinceLast);
		this.persistTimer = (this.opts.setTimer ?? defaultSetTimer)(() => {
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
	 * Persist the latest state. `force` bypasses the identical-skip (terminal
	 * verdicts and teardown must always land on disk). At most ONE write is ever
	 * outstanding; anything arriving during a write is folded into a re-arm.
	 */
	/**
	 * One sink's publication state. `ready` is the only state that may advertise a
	 * capability: a caller must never see a surface with nothing readable behind it.
	 */
	sinkState(sink: CaptureSinkName): CaptureSinkState {
		return this.sinks[sink].state;
	}

	private persistNow(force = false): void {
		if (this.writeInFlight) {
			this.persist.coalesced++;
			this.persistDirty = true;
			return;
		}
		const nowMs = (this.opts.now ?? Date.now)();
		const attempts: Array<{ sink: CaptureSinkName; write: () => void | Promise<void>; identity: string; updatedAt: string; bytes: number }> = [];

		if (this.opts.persistState) {
			const snapshot = this.snapshot();
			const identity = `${this.status}|${JSON.stringify(snapshot.state)}`;
			const planned = this.planWrite("semantic", identity, nowMs, force);
			if (planned) {
				attempts.push({
					sink: "semantic",
					// A forced durable write of unchanged content keeps the timestamp the
					// content actually changed at, on this surface as much as on the other.
					write: () => this.opts.persistState?.({ ...snapshot, updatedAt: planned.updatedAt }),
					identity,
					updatedAt: planned.updatedAt,
					bytes: Buffer.byteLength(identity, "utf8"),
				});
			}
		}
		if (this.opts.persistProjection) {
			const projection = this.projection();
			const identity = projectionIdentity(projection);
			const planned = this.planWrite("compact", identity, nowMs, force);
			if (planned) {
				attempts.push({
					sink: "compact",
					write: () => this.opts.persistProjection?.({ ...projection, updatedAt: planned.updatedAt }),
					identity,
					updatedAt: planned.updatedAt,
					bytes: Buffer.byteLength(identity, "utf8"),
				});
			}
		}
		this.persistDirty = false;
		if (attempts.length === 0) {
			this.scheduleRetry();
			return;
		}

		const bytes = attempts.reduce((total, attempt) => total + attempt.bytes, 0);
		this.writeInFlight = true;
		this.persist.writes++;
		this.persist.lastBytes = bytes;
		this.persist.totalBytes += bytes;
		if (bytes > this.persist.maxBytes) this.persist.maxBytes = bytes;
		this.persist.lastWriteAtMs = nowMs;

		let outstanding = attempts.length;
		const settle = (): void => {
			if (--outstanding > 0) return;
			this.writeInFlight = false;
			if (this.disposed) return;
			if (this.persistDirty) this.schedulePersist();
			else this.scheduleRetry();
		};
		for (const attempt of attempts) {
			const succeeded = (): void => {
				const state = this.sinks[attempt.sink];
				state.state = "ready";
				state.identity = attempt.identity;
				state.updatedAt = attempt.updatedAt;
				state.failures = 0;
				state.retryAtMs = null;
				settle();
			};
			const failed = (): void => {
				const state = this.sinks[attempt.sink];
				// The identity is NOT advanced, so the SAME content is retried; a ready sink
				// keeps its last good artifact rather than losing it to a failed replacement.
				state.state = state.state === "ready" ? "ready" : "failed";
				state.failures++;
				state.retryAtMs = (this.opts.now ?? Date.now)() + this.retryDelayMs(state.failures);
				this.persist.failures++;
				settle();
			};
			try {
				const result = attempt.write();
				if (result && typeof (result as Promise<void>).then === "function") {
					(result as Promise<void>).then(succeeded, failed);
					continue;
				}
				succeeded();
			} catch {
				failed();
			}
		}
	}

	/**
	 * Decide whether this sink writes now, and with which content timestamp.
	 * Unchanged content is skipped once the sink is `ready`; a sink that has never
	 * published, or owes a retry, writes the same content again and keeps the
	 * timestamp the content actually changed at.
	 */
	private planWrite(
		sink: CaptureSinkName,
		identity: string,
		nowMs: number,
		force: boolean,
	): { updatedAt: string } | null {
		const state = this.sinks[sink];
		const changed = identity !== state.identity;
		const owesRetry = state.retryAtMs !== null && nowMs >= state.retryAtMs;
		const neverPublished = state.state !== "ready";
		if (!force && !changed && !owesRetry && !neverPublished && this.opts.persistSkipIdentical !== false) {
			this.persist.skippedIdentical++;
			return null;
		}
		if (state.retryAtMs !== null && !owesRetry && !changed && !force) return null; // backing off
		const updatedAt = changed || state.updatedAt === null ? new Date(nowMs).toISOString() : state.updatedAt;
		return { updatedAt };
	}

	/** The earliest retry deadline any sink owes, or null when none does. */
	private earliestRetryMs(): number | null {
		let earliest: number | null = null;
		for (const sink of CAPTURE_SINKS) {
			const at = this.sinks[sink].retryAtMs;
			if (at !== null && (earliest === null || at < earliest)) earliest = at;
		}
		return earliest;
	}

	/**
	 * Arm the retry itself, rather than waiting for new output to carry it. A quiet
	 * pane produces no further events, so a failed publication would otherwise never
	 * heal — which is the whole reason a failure is retryable at all.
	 */
	private scheduleRetry(): void {
		if (this.persistTimer || this.disposed) return;
		const earliest = this.earliestRetryMs();
		if (earliest === null) return;
		const delay = Math.max(0, earliest - (this.opts.now ?? Date.now)());
		this.persistTimer = (this.opts.setTimer ?? defaultSetTimer)(() => {
			this.persistTimer = null;
			this.persistNow();
		}, delay);
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
	flush(): void {
		if (this.disposed) return;
		this.drainNow();
		this.cancelPersistTimer(); // the drain may have re-armed the debounce
		this.persistNow(true);
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
			inFlight: this.writeInFlight,
			minIntervalMs: this.opts.persistMinIntervalMs ?? DEFAULT_PERSIST_MIN_INTERVAL_MS,
		};
	}

	/** Read-only sequence-gap accounting observed while ingesting. */
	resyncCounters(): ParserResyncCounters {
		return { ...this.resync };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelPersistTimer();
		// Through the guarded primitive, never core.dispose() directly: a fatal failure
		// may already have released it, and ghostty-web's free does not clear the
		// handle, so a second free corrupts the WASM heap rather than throwing.
		this.releaseCore();
	}
}
