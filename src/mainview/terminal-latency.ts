/**
 * Terminal performance probe — the numbers the "it feels laggy" reports are about.
 *
 * Before this there was no end-to-end instrumentation anywhere in the app, so
 * every latency claim (including the audit that produced it) was reasoning about
 * code rather than measurement.
 *
 * **Five rolling distributions**, sampled from the terminal that is already running:
 *
 *  - `echo`   keystroke → the PTY's bytes back in the renderer. Everything
 *             outside the browser: socket, bun's batch window, tmux, the shell.
 *  - `paint`  keystroke → the first ghostty frame painted after those bytes were
 *             written. What the user actually waits for.
 *  - `write`  time inside `term.write()` — the WASM parse.
 *  - `frame`  time inside `renderer.render()` — the canvas cost per frame.
 *  - `gap`    wall-clock between two painted frames. `frame` says how expensive a
 *             frame was; `gap` says whether the loop kept its slot at all, which
 *             is the one that reads as choppy.
 *
 * **Plus per-second counters** ({@link RateCounters}), because a distribution
 * cannot answer "is anything even arriving". ghostty renders on an unconditional
 * `requestAnimationFrame` loop, so `fps` near 60 is the loop being healthy and
 * says nothing about smoothness — `updates` (how many frames carried new bytes)
 * is the rate at which the picture actually changed.
 *
 * Only IDLE typing is sampled for `echo`/`paint`: a round trip is started by a
 * single printable keystroke after {@link QUIET_BEFORE_MS} of silence, so an
 * agent streaming output can never be mistaken for an echo. An unanswered
 * keystroke is abandoned after {@link SAMPLE_TIMEOUT_MS} rather than recorded as
 * a huge one.
 *
 * Read it live from devtools or an automated browser session with
 * `window.__dev3TerminalLatency()`, or watch it in View → Debug → Terminal
 * Performance; a summary also goes to the backend log every
 * {@link REPORT_INTERVAL_MS}, which is what survives a restart.
 */

import { createRollingRate, ROLLING_WINDOW_MS } from "../shared/rolling-rate";

/** Samples kept per stage. At 60 fps `frame` covers the last ~4 seconds. */
export const MAX_SAMPLES = 240;
/** Silence required before a keystroke may start a round trip. */
export const QUIET_BEFORE_MS = 150;
/** A keystroke with no output after this is abandoned, not recorded. */
export const SAMPLE_TIMEOUT_MS = 1000;
/** How often a summary is pushed to the log sink. */
export const REPORT_INTERVAL_MS = 60_000;
/** The counters report events per this many milliseconds. */
export const RATE_WINDOW_MS = ROLLING_WINDOW_MS;
/** A gap longer than this missed its slot on a 60 Hz display. */
export const LONG_FRAME_MS = 24;
/**
 * A gap longer than this is not a dropped frame — the tab was hidden, the pane
 * was detached, or the machine slept. Recording it would poison both the
 * distribution and the long-frame count.
 */
export const FRAME_GAP_CEILING_MS = 500;

export type LatencyStage = "echo" | "paint" | "write" | "frame" | "gap";

const STAGES: readonly LatencyStage[] = ["echo", "paint", "write", "frame", "gap"];

export interface StageStats {
	count: number;
	p50: number;
	p95: number;
	max: number;
}

const RATE_KEYS = ["fps", "updates", "bytes", "messages", "wheelEvents", "wheelLines", "longFrames"] as const;

/** Everything counted over the last {@link RATE_WINDOW_MS}, expressed per second. */
export interface RateCounters {
	/** Frames the vendor's render loop actually painted. ~60 on a healthy loop. */
	fps: number;
	/** `term.write()` calls — how often the picture had new content to show. */
	updates: number;
	/** Bytes the PTY delivered. */
	bytes: number;
	/** WebSocket messages. Two per 16 ms window is bun's leading+trailing flush. */
	messages: number;
	/** Wheel events the browser delivered. */
	wheelEvents: number;
	/** Scroll lines the pacer let through to tmux. */
	wheelLines: number;
	/** Frames that missed their slot ({@link LONG_FRAME_MS}). */
	longFrames: number;
}

export type LatencySnapshot = Record<LatencyStage, StageStats> & {
	rates: RateCounters;
	/** Scroll lines the pacer is still holding, right now. Not a rate. */
	wheelBacklog: number;
};

export interface TerminalLatencyProbe {
	/** A keystroke left the terminal. Only a lone printable one starts a sample. */
	noteInput(data: string): void;
	/** A message arrived from the PTY, before it is decoded or written. */
	noteOutput(): void;
	/** How many bytes that message carried, once known. */
	noteBytes(count: number): void;
	/** How long `term.write()` took. */
	noteWrite(ms: number): void;
	/** A ghostty frame finished painting, and how long it took. */
	noteFrame(ms: number): void;
	/** The browser delivered a wheel event. */
	noteWheelEvent(): void;
	/** The pacer released `lines` to tmux and is still holding `backlog`. */
	noteWheelSent(lines: number, backlog: number): void;
	snapshot(): LatencySnapshot;
	dispose(): void;
}

export interface ProbeOptions {
	/** Where a periodic summary goes. Omit to only keep it in memory. */
	report?: (snapshot: LatencySnapshot) => void;
	now?: () => number;
	reportIntervalMs?: number;
}

function emptyStats(): StageStats {
	return { count: 0, p50: 0, p95: 0, max: 0 };
}

/** Nearest-rank percentile over a copy, so the ring buffer keeps arrival order. */
export function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil(fraction * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * A lone printable character — the only input whose echo is unambiguous. A paste
 * arrives as many characters, and a control sequence may produce no echo at all.
 */
export function isSamplableKeystroke(data: string): boolean {
	if (data.length !== 1) return false;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}

export function createTerminalLatencyProbe(opts: ProbeOptions = {}): TerminalLatencyProbe {
	const now = opts.now ?? (() => performance.now());
	const samples: Record<LatencyStage, number[]> = { echo: [], paint: [], write: [], frame: [], gap: [] };

	/** Keystroke waiting for its echo. */
	let pendingInputAt: number | null = null;
	/** Echo that arrived and is waiting for the frame that shows it. */
	let pendingPaintFrom: number | null = null;
	let lastOutputAt = -Infinity;
	let lastFrameAt: number | null = null;

	const rates = createRollingRate(RATE_KEYS, now);
	let wheelBacklog = 0;

	function push(stage: LatencyStage, ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) return;
		const bucket = samples[stage];
		bucket.push(ms);
		if (bucket.length > MAX_SAMPLES) bucket.shift();
	}

	function snapshot(): LatencySnapshot {
		const out = {} as LatencySnapshot;
		for (const stage of STAGES) {
			const bucket = samples[stage];
			if (bucket.length === 0) {
				out[stage] = emptyStats();
				continue;
			}
			const sorted = [...bucket].sort((a, b) => a - b);
			out[stage] = {
				count: sorted.length,
				p50: round(percentile(sorted, 0.5)),
				p95: round(percentile(sorted, 0.95)),
				max: round(sorted[sorted.length - 1]),
			};
		}
		out.rates = rates.read();
		out.wheelBacklog = wheelBacklog;
		return out;
	}

	const reportEvery = opts.reportIntervalMs ?? REPORT_INTERVAL_MS;
	const timer = opts.report
		? setInterval(() => {
				const snap = snapshot();
				// Nothing happened in this window — an empty line every minute per pane
				// would drown the very log this is meant to make readable.
				if (snap.echo.count === 0 && snap.frame.count === 0) return;
				opts.report?.(snap);
			}, reportEvery)
		: null;

	return {
		noteInput(data) {
			if (!isSamplableKeystroke(data)) return;
			const at = now();
			// Typing into a stream of agent output: the next bytes are not this
			// keystroke's echo, so there is nothing honest to measure.
			if (at - lastOutputAt < QUIET_BEFORE_MS) return;
			pendingInputAt = at;
		},
		noteOutput() {
			const at = now();
			rates.add("messages");
			lastOutputAt = at;
			if (pendingInputAt === null) return;
			const elapsed = at - pendingInputAt;
			pendingInputAt = null;
			// The shell took too long to answer — that is the shell's latency, not ours.
			if (elapsed > SAMPLE_TIMEOUT_MS) return;
			push("echo", elapsed);
			pendingPaintFrom = at - elapsed;
		},
		noteBytes(count) {
			rates.add("bytes", count);
		},
		noteWrite(ms) {
			rates.add("updates");
			push("write", ms);
		},
		noteFrame(ms) {
			const at = now();
			rates.add("fps");
			if (lastFrameAt !== null) {
				const gap = at - lastFrameAt;
				// A hidden tab paints nothing; that stretch is not a dropped frame.
				if (gap <= FRAME_GAP_CEILING_MS) {
					push("gap", gap);
					if (gap > LONG_FRAME_MS) rates.add("longFrames");
				}
			}
			lastFrameAt = at;
			push("frame", ms);
			if (pendingPaintFrom === null) return;
			const elapsed = at - pendingPaintFrom;
			pendingPaintFrom = null;
			if (elapsed > SAMPLE_TIMEOUT_MS) return;
			push("paint", elapsed);
		},
		noteWheelEvent() {
			rates.add("wheelEvents");
		},
		noteWheelSent(lines, backlog) {
			rates.add("wheelLines", lines);
			wheelBacklog = Math.max(0, backlog);
		},
		snapshot,
		dispose() {
			if (timer !== null) clearInterval(timer);
			pendingInputAt = null;
			pendingPaintFrom = null;
		},
	};
}

// ── Live read-out ────────────────────────────────────────────────────
// A registry rather than a prop chain: the panes that matter are mounted deep
// inside the task view, and both readers — the devtools function and the Debug
// overlay — want every pane at once, which is the view an audit needs.

const liveProbes = new Map<string, TerminalLatencyProbe>();

declare global {
	interface Window {
		__dev3TerminalLatency?: () => Record<string, LatencySnapshot>;
	}
}

/** Every registered pane, keyed the way it registered itself. */
export function snapshotAllPanes(): Record<string, LatencySnapshot> {
	const out: Record<string, LatencySnapshot> = {};
	for (const [key, live] of liveProbes) out[key] = live.snapshot();
	return out;
}

export function registerLatencyProbe(paneKey: string, probe: TerminalLatencyProbe): () => void {
	liveProbes.set(paneKey, probe);
	if (typeof window !== "undefined" && !window.__dev3TerminalLatency) {
		window.__dev3TerminalLatency = snapshotAllPanes;
	}
	return () => {
		if (liveProbes.get(paneKey) === probe) liveProbes.delete(paneKey);
	};
}

/** Test-only: drop every registered pane. */
export function __resetLatencyProbesForTests(): void {
	liveProbes.clear();
}
