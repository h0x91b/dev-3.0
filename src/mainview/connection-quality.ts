/**
 * The sampler behind the header's remote connection-quality readout.
 *
 * What a sample is, and what the numbers mean, lives in
 * `shared/connection-quality.ts`. This file only owns *when* to take one.
 *
 * **The measurement must not become the lag.** One sample is a `ping` request
 * and its answer: ~45 bytes out, ~90 bytes back. At one every
 * {@link DEFAULT_SAMPLE_INTERVAL_MS} that is roughly 27 bytes a second, against
 * a terminal stream that moves kilobytes — under a thousandth of the traffic on
 * the link being measured, and one extra event-loop turn on the host.
 *
 * Sampling stops entirely while the tab is hidden. A backgrounded tab has its
 * timers throttled to about one tick a minute anyway, so the samples it would
 * produce measure the browser's throttling rather than the link.
 *
 * Remote only, and by construction: the desktop bridge exposes no round-trip
 * probe (`getRoundTripProbe()` returns null), so on desktop this starts and
 * immediately does nothing.
 */

import {
	createQualityWindow,
	DEFAULT_SAMPLE_INTERVAL_MS,
	emptyQualityStats,
	SAMPLE_TIMEOUT_MS,
	type QualityStats,
} from "../shared/connection-quality";
import { getRoundTripProbe, type RoundTripProbe } from "./rpc";

export const CONNECTION_QUALITY_EVENT = "dev3:connectionQuality";

export interface SamplerOptions {
	probe?: RoundTripProbe | null;
	intervalMs?: number;
	timeoutMs?: number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	/** Omit to sample unconditionally (tests); the app passes document visibility. */
	isVisible?: () => boolean;
	onStats?: (stats: QualityStats) => void;
}

export interface ConnectionQualitySampler {
	/** Take one sample now, outside the schedule (first paint, tab regains focus). */
	sampleNow(): Promise<void>;
	stats(): QualityStats;
	stop(): void;
}

export function createConnectionQualitySampler(opts: SamplerOptions = {}): ConnectionQualitySampler {
	const probe = opts.probe ?? null;
	const intervalMs = opts.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
	const timeoutMs = opts.timeoutMs ?? SAMPLE_TIMEOUT_MS;
	const setIntervalFn = opts.setIntervalFn ?? setInterval;
	const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
	const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
	const isVisible = opts.isVisible ?? (() => true);

	const window_ = createQualityWindow();
	let inFlight = false;
	let stopped = false;

	function publish(): void {
		opts.onStats?.(window_.stats());
	}

	async function sampleNow(): Promise<void> {
		if (stopped || probe === null || inFlight || !isVisible()) return;
		inFlight = true;
		// Cleared once the race settles: an answered sample would otherwise leave its
		// deadline timer pending for the whole timeout, which is harmless in a browser
		// and enough to hang a fake-timer test.
		let deadline: ReturnType<typeof setTimeout> | null = null;
		try {
			// A stalled request is a loss, not a large sample: averaging it in would
			// move the median toward a value no round trip ever had.
			const timedOut = Symbol("timeout");
			const result = await Promise.race([
				probe(),
				new Promise<typeof timedOut>((resolve) => {
					deadline = setTimeoutFn(() => resolve(timedOut), timeoutMs);
				}),
			]);
			if (stopped) return;
			if (result === timedOut) window_.addLoss();
			else window_.add(result);
			publish();
		} catch {
			if (stopped) return;
			window_.addLoss();
			publish();
		} finally {
			if (deadline !== null) clearTimeoutFn(deadline);
			inFlight = false;
		}
	}

	const timer = probe === null ? null : setIntervalFn(() => void sampleNow(), intervalMs);

	return {
		sampleNow,
		stats: () => window_.stats(),
		stop() {
			stopped = true;
			if (timer !== null) clearIntervalFn(timer);
		},
	};
}

// ── App-wide singleton ───────────────────────────────────────────────
// One sampler per page, read by the header widget and by devtools. Making the
// component own it would restart the window on every remount and would sample
// twice if the widget ever appeared in two places (the header pill and the
// narrow kebab sheet are exactly that case).

let singleton: ConnectionQualitySampler | null = null;
let lastStats: QualityStats = emptyQualityStats();
/** Kept so the reset below can take the listener with it. */
let onVisibility: (() => void) | null = null;

declare global {
	interface Window {
		__dev3ConnectionQuality?: () => QualityStats;
		__dev3ProbeConnection?: (count?: number) => Promise<QualityStats>;
	}
}

/**
 * Take `count` round trips back to back and return their own statistics, without
 * touching the widget's rolling window.
 *
 * This is the A/B instrument, not part of the widget: comparing the tunnel URL
 * against the direct one needs a burst on each within the same minute, and the
 * 5-second cadence would take several minutes per side and drift into different
 * machine load. Serialized on purpose — parallel probes would measure how many
 * requests the link can hold at once, which is a different question.
 */
export async function probeBurst(count = 20): Promise<QualityStats> {
	const probe = getRoundTripProbe();
	const window_ = createQualityWindow(Math.max(1, count));
	if (!probe) return window_.stats();
	for (let i = 0; i < count; i += 1) {
		try {
			window_.add(await probe());
		} catch {
			window_.addLoss();
		}
	}
	return window_.stats();
}

/** Latest published stats. Empty until the first sample answers. */
export function getConnectionQuality(): QualityStats {
	return lastStats;
}

/** Idempotent: safe to call from every mount. Returns null on desktop. */
export function startConnectionQualitySampling(): ConnectionQualitySampler | null {
	if (singleton) return singleton;
	const probe = getRoundTripProbe();
	if (!probe) return null;
	singleton = createConnectionQualitySampler({
		probe,
		isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
		onStats: (stats) => {
			lastStats = stats;
			try {
				window.dispatchEvent(new CustomEvent(CONNECTION_QUALITY_EVENT, { detail: stats }));
			} catch {
				/* no window (tests) — the getter still returns the value */
			}
		},
	});
	if (typeof window !== "undefined") {
		window.__dev3ConnectionQuality = getConnectionQuality;
		window.__dev3ProbeConnection = probeBurst;
	}
	// A tab coming back from the background has a window full of stale samples and
	// no fresh one for up to the whole interval; ask immediately instead.
	if (typeof document !== "undefined") {
		onVisibility = () => {
			if (document.visibilityState === "visible") void singleton?.sampleNow();
		};
		document.addEventListener("visibilitychange", onVisibility);
	}
	void singleton.sampleNow();
	return singleton;
}

/** Test-only: drop the singleton and its published stats. */
export function __resetConnectionQualityForTests(): void {
	singleton?.stop();
	singleton = null;
	if (onVisibility !== null && typeof document !== "undefined") {
		document.removeEventListener("visibilitychange", onVisibility);
	}
	onVisibility = null;
	lastStats = emptyQualityStats();
}
