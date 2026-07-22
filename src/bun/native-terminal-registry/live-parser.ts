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
 */

import {
	GhosttyLiveParser,
	type GhosttyLiveOptions,
	type LiveParserCore,
	type NativeSemanticState,
	LIVE_PARSER_ID,
} from "./ghostty-live";
import {
	DEFAULT_PARSER_QUEUE_MAX_BYTES,
	DEFAULT_PARSER_QUEUE_MAX_EVENTS,
	ParserEventQueue,
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
export const DEFAULT_MAX_REPLIES_PER_DRAIN = 64;
const LATENCY_RING_SIZE = 512;

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
	persistDebounceMs?: number;
	maxRepliesPerDrain?: number;
	/** Write one parser-generated reply back to the SAME PTY. Must not throw. */
	writeReply: (reply: string) => void;
	/** Persist a snapshot (atomic file write in the host). Failures are contained. */
	persistState: (snapshot: ParserStateSnapshot) => void;
	/** Test seams — production uses the defaults. */
	createCore?: (options: GhosttyLiveOptions) => Promise<LiveParserCore>;
	schedule?: (fn: () => void) => void;
	now?: () => number;
	memory?: () => ParserMemoryStats;
	/** Test-only injected fault (DEV3_NATIVE_SESSION_PARSER_FAULT). */
	fault?: "ingest" | null;
}

const defaultSchedule = (fn: () => void): void => {
	if (typeof setImmediate === "function") setImmediate(fn);
	else setTimeout(fn, 0);
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
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private lastState: NativeSemanticState | null = null;

	private constructor(
		private readonly core: LiveParserCore,
		private readonly opts: LiveParserPipelineOptions,
	) {
		this.queue = new ParserEventQueue(
			opts.queueMaxBytes ?? DEFAULT_PARSER_QUEUE_MAX_BYTES,
			opts.queueMaxEvents ?? DEFAULT_PARSER_QUEUE_MAX_EVENTS,
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
		return new LiveParserPipeline(core, opts);
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

	/** Overflow/failure end state: parsing stops, the verdict is persisted once. */
	private enterTerminalState(status: ParserHealthStatus): void {
		this.status = status;
		this.queue.clear();
		this.persistNow();
	}

	private schedulePersist(): void {
		if (this.persistTimer || this.disposed) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			this.persistNow();
		}, this.opts.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS);
		this.persistTimer.unref?.();
	}

	private persistNow(): void {
		try {
			this.opts.persistState(this.snapshot());
		} catch {
			// a failed snapshot write must never take the host down
		}
	}

	/** Build the bounded snapshot; inspection errors degrade to the last state. */
	snapshot(): ParserStateSnapshot {
		if (this.status === "live") {
			try {
				this.lastState = this.core.inspect(this.opts.snapshotScrollbackCap ?? DEFAULT_SNAPSHOT_SCROLLBACK_CAP);
			} catch (err) {
				this.failureError = err instanceof Error ? err.message : String(err);
				this.status = "failed";
				this.queue.clear();
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

	/** Force-drain pending events and persist immediately (detach/shutdown path). */
	flush(): void {
		if (this.disposed) return;
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.drainNow();
		this.persistNow();
	}

	get healthStatus(): ParserHealthStatus {
		return this.status;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		try {
			this.core.dispose();
		} catch {
			// WASM already freed
		}
	}
}
