/**
 * Bounded parser event queue for the live-parser proof (seq 1228).
 *
 * The Bun.Terminal data callback must do only bounded work and must NEVER touch
 * Ghostty WASM (Bun 1.3.14 on Windows returns a negative WASM allocation
 * pointer when Ghostty runs inside that callback — decision 146). The callback
 * therefore only copies raw bytes into this queue; a deferred drain on the
 * normal event loop feeds the parser later.
 *
 * The queue is byte-capped with EXPLICIT overflow accounting. Once an output
 * chunk is dropped the parsed screen can no longer be trusted, so consumers
 * treat the first drop as a terminal "overflowed" verdict instead of silently
 * rendering a corrupt screen. Pure data structure — unit-testable under vitest.
 */

export const DEFAULT_PARSER_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
/** Safety valve for event-count floods (e.g. a resize storm of tiny frames). */
export const DEFAULT_PARSER_QUEUE_MAX_EVENTS = 65_536;
/**
 * Fraction of either cap at which a backlog is reported as `slow-consumer` —
 * the typed early warning that precedes the terminal `overflowed` verdict.
 */
export const DEFAULT_QUEUE_SLOW_CONSUMER_RATIO = 0.5;

export interface ParserOutputEvent {
	kind: "output";
	seq: number;
	bytes: Uint8Array;
}

export interface ParserResizeEvent {
	kind: "resize";
	seq: number;
	cols: number;
	rows: number;
}

export type ParserEvent = ParserOutputEvent | ParserResizeEvent;

export interface ParserQueueOverflow {
	droppedChunks: number;
	droppedBytes: number;
	droppedResizes: number;
}

/** Typed backpressure verdict — never a silent stall, never unbounded growth. */
export type ParserQueuePressure = "nominal" | "slow-consumer" | "overflowed";

/** Immutable read-only view of the queue. Exposes counters, never the events. */
export interface ParserQueueCounters {
	pendingBytes: number;
	pendingEvents: number;
	highWaterBytes: number;
	highWaterEvents: number;
	maxBytes: number;
	maxEvents: number;
	lastSeq: number;
	/** Times the backlog crossed into `slow-consumer` from a nominal state. */
	slowConsumerEpisodes: number;
	overflow: ParserQueueOverflow;
	overflowed: boolean;
	pressure: ParserQueuePressure;
}

export class ParserEventQueue {
	private events: ParserEvent[] = [];
	private bytes = 0;
	private seq = 0;
	private highWaterBytes = 0;
	private highWaterEvents = 0;
	private slowConsumerEpisodes = 0;
	private inSlowConsumer = false;
	private readonly dropped: ParserQueueOverflow = { droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 };

	constructor(
		private readonly maxBytes: number = DEFAULT_PARSER_QUEUE_MAX_BYTES,
		private readonly maxEvents: number = DEFAULT_PARSER_QUEUE_MAX_EVENTS,
		private readonly slowConsumerRatio: number = DEFAULT_QUEUE_SLOW_CONSUMER_RATIO,
	) {}

	/** Refresh high-water marks and the slow-consumer episode counter after a push. */
	private observeDepth(): void {
		if (this.bytes > this.highWaterBytes) this.highWaterBytes = this.bytes;
		if (this.events.length > this.highWaterEvents) this.highWaterEvents = this.events.length;
		const slow = this.isSlowConsumer();
		if (slow && !this.inSlowConsumer) this.slowConsumerEpisodes++;
		this.inSlowConsumer = slow;
	}

	private isSlowConsumer(): boolean {
		return this.bytes >= this.maxBytes * this.slowConsumerRatio || this.events.length >= this.maxEvents * this.slowConsumerRatio;
	}

	/**
	 * Enqueue one PTY output chunk, copying it (the callback's buffer may be
	 * reused by the runtime). Returns false when the chunk was dropped because it
	 * would exceed the byte or event cap; the drop is counted, never thrown.
	 */
	enqueueOutput(bytes: Uint8Array): boolean {
		this.seq++;
		if (bytes.length === 0) return true;
		if (this.bytes + bytes.length > this.maxBytes || this.events.length >= this.maxEvents) {
			this.dropped.droppedChunks++;
			this.dropped.droppedBytes += bytes.length;
			return false;
		}
		this.events.push({ kind: "output", seq: this.seq, bytes: bytes.slice() });
		this.bytes += bytes.length;
		this.observeDepth();
		return true;
	}

	/** Enqueue a resize marker at its real position in the output order. */
	enqueueResize(cols: number, rows: number): boolean {
		this.seq++;
		if (this.events.length >= this.maxEvents) {
			this.dropped.droppedResizes++;
			return false;
		}
		this.events.push({ kind: "resize", seq: this.seq, cols, rows });
		this.observeDepth();
		return true;
	}

	/** Remove and return every pending event in enqueue order. */
	drain(): ParserEvent[] {
		const drained = this.events;
		this.events = [];
		this.bytes = 0;
		this.inSlowConsumer = false;
		return drained;
	}

	/** Drop all pending events without returning them (overflow shutdown path). */
	clear(): void {
		this.events = [];
		this.bytes = 0;
		this.inSlowConsumer = false;
	}

	get pendingBytes(): number {
		return this.bytes;
	}

	get pendingEvents(): number {
		return this.events.length;
	}

	/** Monotonic sequence number of the most recently enqueued (or dropped) event. */
	get lastSeq(): number {
		return this.seq;
	}

	get overflow(): ParserQueueOverflow {
		return { ...this.dropped };
	}

	get overflowed(): boolean {
		return this.dropped.droppedChunks > 0 || this.dropped.droppedResizes > 0;
	}

	/** Peak backlog since construction — drains and clears never lower it. */
	get highWater(): { bytes: number; events: number } {
		return { bytes: this.highWaterBytes, events: this.highWaterEvents };
	}

	get pressure(): ParserQueuePressure {
		if (this.overflowed) return "overflowed";
		return this.isSlowConsumer() ? "slow-consumer" : "nominal";
	}

	/** One flat, frozen-by-copy read of everything observable. No queue internals. */
	counters(): ParserQueueCounters {
		return {
			pendingBytes: this.bytes,
			pendingEvents: this.events.length,
			highWaterBytes: this.highWaterBytes,
			highWaterEvents: this.highWaterEvents,
			maxBytes: this.maxBytes,
			maxEvents: this.maxEvents,
			lastSeq: this.seq,
			slowConsumerEpisodes: this.slowConsumerEpisodes,
			overflow: { ...this.dropped },
			overflowed: this.overflowed,
			pressure: this.pressure,
		};
	}
}
