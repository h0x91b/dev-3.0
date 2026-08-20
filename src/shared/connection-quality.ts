/**
 * Remote connection quality — what the number means, in one place.
 *
 * The widget is only as honest as its definition, so the definition is code
 * rather than prose. **One sample is the round trip of a `ping` RPC request
 * through the same `/rpc` WebSocket every other request already uses**: the
 * renderer stamps the send, the server answers, the renderer stamps the
 * response. In remote mode that path is browser → Cloudflare edge →
 * `cloudflared` on the host → our server → all the way back, which is exactly
 * the loop a click waits for.
 *
 * Deliberately NOT measured here:
 *
 *  - **ICMP or TCP to the edge.** A different path with a different queue; it
 *    always looks better than reality and cannot see our own server at all.
 *  - **The terminal `/pty` socket.** Keystroke-to-pixel already has its own
 *    probe (`mainview/terminal-latency.ts`, stages `echo` and `paint`), and it
 *    additionally carries tmux and the shell. Two probes, two questions.
 *
 * The split between *us* and *the network* comes from `serverMs`, stamped by
 * the server between reading the frame and writing the answer. Both stamps are
 * on the host's clock, so clock skew between browser and host cannot corrupt
 * it. `rtt - serverMs` is everything outside our process; what it cannot
 * further divide is browser↔edge from edge↔`cloudflared`, because neither
 * hop reports itself to us. Comparing the same widget on the direct-LAN URL is
 * what isolates the tunnel's own contribution.
 */

/** Samples kept. At {@link DEFAULT_SAMPLE_INTERVAL_MS} this is ~2.5 minutes. */
export const MAX_SAMPLES = 30;

/** How often a sample is taken while the page is visible. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;

/**
 * A sample that has not answered by now is recorded as a loss, not as a huge
 * number: a stalled request says "unreachable", and averaging it in would
 * quietly drag the median toward a value no round trip ever had.
 */
export const SAMPLE_TIMEOUT_MS = 5_000;

/** Round trip (p50), in ms, at or above which the link stops being quiet. */
export const RTT_DEGRADED_MS = 150;
/** Round trip (p50), in ms, at or above which the link reads as bad. */
export const RTT_BAD_MS = 400;
/** Jitter, in ms, at or above which the link stops being quiet. */
export const JITTER_DEGRADED_MS = 30;
/** Jitter, in ms, at or above which the link reads as bad. */
export const JITTER_BAD_MS = 100;
/** Share of lost samples, 0..1, at or above which the link reads as bad. */
export const LOSS_BAD_RATIO = 0.2;

export type ConnectionVerdict = "good" | "degraded" | "bad";

export interface QualitySample {
	/** Renderer send → renderer receive, in ms. */
	rttMs: number;
	/** Host-side span between reading the frame and writing the answer, if known. */
	serverMs: number | null;
}

export interface QualityStats {
	/** Samples in the window, losses excluded. */
	count: number;
	/** Samples that never answered within {@link SAMPLE_TIMEOUT_MS}. */
	lost: number;
	/** Median round trip. The headline number. */
	p50: number;
	p95: number;
	/**
	 * Mean absolute deviation from the median — the "laggy" feeling that a
	 * median hides. Chosen over p95−p50 because a single spike moves it less.
	 */
	jitter: number;
	/** Median host-side span, or null when no sample carried one. */
	serverP50: number | null;
	/**
	 * Median of `rtt - serverMs`: everything outside our process. Null when no
	 * sample carried a server span, because guessing it would invent the very
	 * verdict this widget exists to establish.
	 */
	networkP50: number | null;
	verdict: ConnectionVerdict;
	/** Newest last, for a sparkline. Losses are absent, not zero. */
	recent: number[];
}

export function emptyQualityStats(): QualityStats {
	return {
		count: 0,
		lost: 0,
		p50: 0,
		p95: 0,
		jitter: 0,
		serverP50: null,
		networkP50: null,
		verdict: "good",
		recent: [],
	};
}

/** Nearest-rank percentile over an already-sorted copy. */
export function percentileOf(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil(fraction * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * The worse of what the numbers say. Latency and jitter fail independently — a
 * steady 300 ms and a jumpy 60 ms are both bad links, and taking only one axis
 * would call one of them fine.
 */
export function verdictFor(p50: number, jitter: number, lossRatio: number): ConnectionVerdict {
	if (lossRatio >= LOSS_BAD_RATIO || p50 >= RTT_BAD_MS || jitter >= JITTER_BAD_MS) return "bad";
	if (p50 >= RTT_DEGRADED_MS || jitter >= JITTER_DEGRADED_MS) return "degraded";
	return "good";
}

export interface QualityWindow {
	add(sample: QualitySample): void;
	/** A request that never answered. Counted, never averaged in. */
	addLoss(): void;
	stats(): QualityStats;
	reset(): void;
}

/** Rolling window over the last {@link MAX_SAMPLES} attempts. */
export function createQualityWindow(maxSamples = MAX_SAMPLES): QualityWindow {
	/** Attempts in arrival order; `null` is a loss, so it ages out like a sample. */
	let attempts: (QualitySample | null)[] = [];

	function trim(): void {
		if (attempts.length > maxSamples) attempts = attempts.slice(-maxSamples);
	}

	return {
		add(sample) {
			if (!Number.isFinite(sample.rttMs) || sample.rttMs < 0) return;
			attempts.push(sample);
			trim();
		},
		addLoss() {
			attempts.push(null);
			trim();
		},
		reset() {
			attempts = [];
		},
		stats() {
			const answered = attempts.filter((a): a is QualitySample => a !== null);
			const lost = attempts.length - answered.length;
			if (answered.length === 0) {
				const empty = emptyQualityStats();
				empty.lost = lost;
				// Nothing answered at all: that is not a quiet link.
				empty.verdict = lost > 0 ? "bad" : "good";
				return empty;
			}
			const rtts = answered.map((a) => a.rttMs);
			const sorted = [...rtts].sort((a, b) => a - b);
			const p50 = percentileOf(sorted, 0.5);
			const jitter = rtts.reduce((sum, v) => sum + Math.abs(v - p50), 0) / rtts.length;

			const serverSpans = answered
				.map((a) => a.serverMs)
				.filter((v): v is number => v !== null && Number.isFinite(v));
			const serverP50 = serverSpans.length > 0
				? percentileOf([...serverSpans].sort((a, b) => a - b), 0.5)
				: null;
			const networks = answered
				.filter((a) => a.serverMs !== null && Number.isFinite(a.serverMs))
				.map((a) => Math.max(0, a.rttMs - (a.serverMs as number)));
			const networkP50 = networks.length > 0
				? percentileOf([...networks].sort((a, b) => a - b), 0.5)
				: null;

			return {
				count: answered.length,
				lost,
				p50: round(p50),
				p95: round(percentileOf(sorted, 0.95)),
				jitter: round(jitter),
				serverP50: serverP50 === null ? null : round(serverP50),
				networkP50: networkP50 === null ? null : round(networkP50),
				verdict: verdictFor(p50, jitter, lost / attempts.length),
				recent: rtts.map(round),
			};
		},
	};
}
