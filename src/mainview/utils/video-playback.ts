/** Speeds the media viewer offers, slowest first. */
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** The next offered speed in `direction`; an off-list rate snaps to its neighbour. */
export function stepPlaybackRate(rate: number, direction: 1 | -1): number {
	if (direction > 0) return PLAYBACK_RATES.find((r) => r > rate + 1e-9) ?? PLAYBACK_RATES[PLAYBACK_RATES.length - 1];
	return [...PLAYBACK_RATES].reverse().find((r) => r < rate - 1e-9) ?? PLAYBACK_RATES[0];
}

/** Frame step falls back to this until a real frame rate was measured. */
export const FALLBACK_FPS = 30;

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

/**
 * Frame rate from the gaps between consecutive presented frames. The browser
 * exposes no fps, so the median gap is the honest measure; a value within 1.5%
 * of a standard rate snaps to it (timestamps carry container rounding).
 */
export function estimateFps(intervals: readonly number[]): number | null {
	const usable = intervals.filter((gap) => gap > 0.001 && gap < 1).sort((a, b) => a - b);
	if (usable.length < 3) return null;
	const median = usable[Math.floor(usable.length / 2)];
	const raw = 1 / median;
	const nearest = STANDARD_FPS.reduce((best, fps) => (Math.abs(fps - raw) < Math.abs(best - raw) ? fps : best));
	return Math.abs(nearest - raw) / nearest <= 0.015 ? nearest : Math.round(raw * 100) / 100;
}

/** Gaps needed, and how many feeds in a row must agree, before the rate is final. */
const STABLE_MIN_SAMPLES = 12;
const STABLE_AGREEING_FEEDS = 8;

/**
 * Collects frame gaps from `requestVideoFrameCallback`. Only a gap between two
 * consecutive presented frames counts, and only at 1x: at higher speeds the
 * engine drops frames, and the gap around a dropped one reads as a lower rate.
 * Once the estimate holds steady it is `stable` and should be frozen.
 */
export class FrameRateMeter {
	private last: { mediaTime: number; presentedFrames: number } | null = null;
	private readonly intervals: number[] = [];
	private previous: number | null = null;
	private agreeing = 0;

	feed(mediaTime: number, presentedFrames: number, playbackRate = 1): void {
		if (playbackRate !== 1) {
			this.last = null;
			return;
		}
		const prev = this.last;
		this.last = { mediaTime, presentedFrames };
		if (!prev || presentedFrames - prev.presentedFrames !== 1) return;
		const gap = mediaTime - prev.mediaTime;
		if (gap <= 0) return;
		this.intervals.push(gap);
		if (this.intervals.length > 60) this.intervals.shift();
		const now = estimateFps(this.intervals);
		this.agreeing = now !== null && now === this.previous ? this.agreeing + 1 : 0;
		this.previous = now;
	}

	/** A seek breaks the chain of consecutive frames. */
	reset(): void {
		this.last = null;
	}

	get fps(): number | null {
		return estimateFps(this.intervals);
	}

	get stable(): boolean {
		return this.intervals.length >= STABLE_MIN_SAMPLES && this.agreeing >= STABLE_AGREEING_FEEDS;
	}
}

const frameRateByClip = new Map<string, number>();

/** A clip's settled frame rate, kept for the session so a remount does not lose it. */
export function knownFrameRate(clipId: string): number | null {
	return frameRateByClip.get(clipId) ?? null;
}

export function rememberFrameRate(clipId: string, fps: number): void {
	frameRateByClip.set(clipId, fps);
}

/** Index of the frame shown at `time`. */
export function frameAt(time: number, fps: number): number {
	return Math.max(0, Math.floor(time * fps + 1e-6));
}

/**
 * Where to seek to show `frame`: its middle, so decoder rounding can never land
 * on the neighbour. Clamped inside the clip when the duration is known.
 */
export function frameSeekTime(frame: number, fps: number, duration: number): number {
	const target = (Math.max(0, frame) + 0.5) / fps;
	if (!Number.isFinite(duration) || duration <= 0) return target;
	return Math.min(target, Math.max(0, duration - 0.5 / fps));
}

/** A time's position along the scrubber, 0..100. */
export function timelinePercent(time: number, duration: number): number {
	if (!Number.isFinite(duration) || duration <= 0) return 0;
	return Math.min(100, Math.max(0, (time / duration) * 100));
}

/** The playhead shows `moment`'s frame: same frame index at its rate, else within 20 ms. */
export function isAtMoment(time: number, moment: { time: number; frame: number | null; fps: number | null }, fps: number | null): boolean {
	const rate = moment.fps ?? fps;
	if (rate) return frameAt(time, rate) === (moment.frame ?? frameAt(moment.time, rate));
	return Math.abs(time - moment.time) < 0.02;
}
