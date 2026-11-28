import { useCallback, useEffect, useRef, useState } from "react";
import { formatReviewTimestamp } from "../../shared/review";
import { useT } from "../i18n";
import { paletteShortcutKeys } from "../keymap";
import { isMac, isRemote } from "../utils/platform";
import {
	FALLBACK_FPS,
	FrameRateMeter,
	PLAYBACK_RATES,
	frameAt,
	frameSeekTime,
	knownFrameRate,
	rememberFrameRate,
	stepPlaybackRate,
	timelinePercent,
} from "../utils/video-playback";

const ICON = "'JetBrainsMono Nerd Font Mono'";
/** Arrow-key seek on a video, on the scrubber and on the stage alike. */
export const SEEK_STEP_SECONDS = 5;
const PAGE_SEEK_SECONDS = 60;
/** The −15 s / +15 s buttons and J / L. */
export const JUMP_SECONDS = 15;
/** How long the hidden probe may play before it gives up on a steady rate. */
const PROBE_TIMEOUT_MS = 4000;

export interface VideoMarker {
	id: string;
	time: number;
	/** Accessible name: number, time and the comment's opening words. */
	label: string;
	/** Already handed to the agent or resolved — drawn quieter. */
	done: boolean;
}

/** The ±5 frame buttons. */
export const FRAME_JUMP = 5;
/** A frame-step button or key held this long starts repeating. */
export const HOLD_DELAY_MS = 500;
/** Repeat rate of a held frame step, as a share of the clip's own frame rate. */
export const HOLD_RATE_OF_FPS = 0.5;

/** Index of the clip's last frame; the clip's end is past it, so never count one too many. */
export function lastFrameIndex(duration: number, fps: number): number | null {
	return Number.isFinite(duration) ? Math.max(0, Math.ceil(duration * fps - 1e-6) - 1) : null;
}

/** Where `frames` frames from the intended playhead is, clamped to the clip; null when already at the edge. */
function frameStepTarget(video: HTMLVideoElement, frames: number, fps: number | null): number | null {
	const rate = fps ?? FALLBACK_FPS;
	const from = frameAt(intendedTime(video), rate);
	const last = lastFrameIndex(video.duration, rate) ?? Number.POSITIVE_INFINITY;
	const to = Math.min(last, Math.max(0, from + frames));
	if (to === from && (frames < 0 ? from === 0 : from === last)) return null;
	return frameSeekTime(to, rate, video.duration);
}

/**
 * `frames` frames away, paused — a frame step during playback is meaningless.
 * Goes through the scrub seeker, so steps faster than the decoder coalesce
 * instead of aborting one another. False at the edge of the clip.
 */
export function stepVideoFrame(video: HTMLVideoElement, frames: number, fps: number | null): boolean {
	video.pause();
	const target = frameStepTarget(video, frames, fps);
	if (target === null) return false;
	const seeker = seekers.get(video);
	if (seeker) seeker.seek(target);
	else video.currentTime = target;
	return true;
}

export function seekVideoToEdge(video: HTMLVideoElement, edge: "start" | "end"): void {
	if (edge === "start") video.currentTime = 0;
	else if (Number.isFinite(video.duration)) video.currentTime = video.duration;
}

export interface FrameStepHold {
	/** Steps once now; still held after `HOLD_DELAY_MS`, keeps stepping until `release`. */
	press(direction: 1 | -1): void;
	release(): void;
	dispose(): void;
}

/**
 * Hold-to-repeat for the frame-step buttons and keys. Repeats at half the
 * clip's frame rate, each step from the seeker's pending target: a decode
 * slower than the step skips frames rather than queueing them.
 */
export function createFrameStepHold(video: HTMLVideoElement, getFps: () => number | null): FrameStepHold {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let direction: 1 | -1 = 1;
	const release = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const repeat = () => {
		if (!stepVideoFrame(video, direction, getFps())) { timer = null; return; }
		const rate = (getFps() ?? FALLBACK_FPS) * HOLD_RATE_OF_FPS;
		timer = setTimeout(repeat, 1000 / rate);
	};
	video.addEventListener("play", release);
	return {
		press(next) {
			release();
			direction = next;
			if (stepVideoFrame(video, direction, getFps())) timer = setTimeout(repeat, HOLD_DELAY_MS);
		},
		release,
		dispose() {
			release();
			video.removeEventListener("play", release);
		},
	};
}

/** A frame-step hold for the clip on stage, let go when the window loses focus or is hidden. */
export function useFrameStepHold(video: HTMLVideoElement | null, fps: number | null): FrameStepHold | null {
	const fpsRef = useRef(fps);
	fpsRef.current = fps;
	const [hold, setHold] = useState<FrameStepHold | null>(null);
	useEffect(() => {
		if (!video) { setHold(null); return; }
		const created = createFrameStepHold(video, () => fpsRef.current);
		const onHidden = () => { if (document.visibilityState === "hidden") created.release(); };
		window.addEventListener("blur", created.release);
		document.addEventListener("visibilitychange", onHidden);
		setHold(created);
		return () => {
			created.dispose();
			window.removeEventListener("blur", created.release);
			document.removeEventListener("visibilitychange", onHidden);
		};
	}, [video]);
	return hold;
}

export function stepVideoRate(video: HTMLVideoElement, direction: 1 | -1): void {
	video.playbackRate = stepPlaybackRate(video.playbackRate, direction);
}

export function seekVideoBy(video: HTMLVideoElement, seconds: number): void {
	const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
	video.currentTime = Math.min(end, Math.max(0, intendedTime(video) + seconds));
}

export function jumpVideo(video: HTMLVideoElement, direction: 1 | -1): void {
	seekVideoBy(video, direction * JUMP_SECONDS);
}

export interface ScrubSeeker {
	seek(time: number): void;
	/** The target still waiting for the seek in flight, if any. */
	target(): number | null;
	dispose(): void;
}

const seekers = new WeakMap<HTMLVideoElement, ScrubSeeker>();

/**
 * Where the user last put the playhead: a drag target still waiting for its
 * seek, else the element's own time. Relative seeks start from here.
 */
export function intendedTime(video: HTMLVideoElement): number {
	return seekers.get(video)?.target() ?? video.currentTime;
}

/** Further than this from our own last write, a seek came from someone else. */
const OWN_SEEK_TOLERANCE = 0.005;

/**
 * Live scrubbing: one precise seek in flight, the newest target waits and wins.
 * Not `fastSeek`: WebKit holds backward drags and long jumps on the previous keyframe.
 * Not a seek per move: each aborts the last, so nothing paints until release.
 * See decisions/2026/11/25/precise-coalesced-video-scrub.md.
 */
export function createScrubSeeker(video: HTMLVideoElement, onSettled: () => void = () => {}): ScrubSeeker {
	let pending: number | null = null;
	let written: number | null = null;
	const flush = () => {
		if (pending === null || video.seeking) return;
		written = pending;
		pending = null;
		video.currentTime = written;
		onSettled();
	};
	// A jump, frame step or marker seek wins over a drag target still waiting.
	const onSeeking = () => {
		if (pending === null) return;
		if (written === null || Math.abs(video.currentTime - written) > OWN_SEEK_TOLERANCE) { pending = null; onSettled(); }
	};
	video.addEventListener("seeked", flush);
	video.addEventListener("seeking", onSeeking);
	const seeker: ScrubSeeker = {
		seek(time) { pending = time; flush(); },
		target: () => pending,
		dispose() {
			pending = null;
			if (seekers.get(video) === seeker) seekers.delete(video);
			video.removeEventListener("seeked", flush);
			video.removeEventListener("seeking", onSeeking);
		},
	};
	seekers.set(video, seeker);
	return seeker;
}

/**
 * Plays a muted, invisible copy of the clip at 1x just long enough to read its
 * frame rate, so a paused clip steps by real frames before anyone presses play.
 * Returns a cancel function; the copy is torn down either way.
 */
function probeFrameRate(src: string, onRate: (fps: number) => void): () => void {
	if (typeof document === "undefined") return () => {};
	const probe = document.createElement("video");
	if (typeof probe.requestVideoFrameCallback !== "function") return () => {};
	probe.muted = true;
	probe.playsInline = true;
	probe.preload = "auto";
	probe.setAttribute("aria-hidden", "true");
	probe.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
	const meter = new FrameRateMeter();
	let done = false;
	const finish = (fps: number | null) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		probe.pause();
		probe.removeAttribute("src");
		probe.load();
		probe.remove();
		if (fps !== null) onRate(fps);
	};
	const onFrame: VideoFrameRequestCallback = (_now, meta) => {
		if (done) return;
		meter.feed(meta.mediaTime, meta.presentedFrames, probe.playbackRate);
		if (meter.stable) finish(meter.fps);
		else probe.requestVideoFrameCallback(onFrame);
	};
	const timer = setTimeout(() => finish(meter.fps), PROBE_TIMEOUT_MS);
	probe.requestVideoFrameCallback(onFrame);
	probe.src = src;
	document.body.appendChild(probe);
	void probe.play().catch(() => finish(null));
	return () => finish(null);
}

/**
 * Frame rate of the clip on stage. The engine exposes none, so it is read from
 * `requestVideoFrameCallback`: a hidden probe measures it as soon as the clip
 * opens, playback at 1x refines it, and once steady it is frozen and kept per
 * clip id for the session. Null where the callback does not exist.
 */
export function useVideoFrameRate(video: HTMLVideoElement | null, clipId: string | null): number | null {
	const [fps, setFps] = useState<number | null>(() => (clipId ? knownFrameRate(clipId) : null));
	useEffect(() => {
		const known = clipId ? knownFrameRate(clipId) : null;
		setFps(known);
		if (known !== null || !video || !clipId || typeof video.requestVideoFrameCallback !== "function") return;
		let settled = false;
		const settle = (value: number) => {
			if (settled) return;
			settled = true;
			rememberFrameRate(clipId, value);
			setFps(value);
		};
		const meter = new FrameRateMeter();
		let handle = 0;
		const onFrame: VideoFrameRequestCallback = (_now, meta) => {
			if (settled) return;
			meter.feed(meta.mediaTime, meta.presentedFrames, video.playbackRate);
			const next = meter.fps;
			if (meter.stable && next !== null) { settle(next); return; }
			if (next !== null) setFps((prev) => (prev === next ? prev : next));
			handle = video.requestVideoFrameCallback(onFrame);
		};
		const onSeeking = () => meter.reset();
		handle = video.requestVideoFrameCallback(onFrame);
		video.addEventListener("seeking", onSeeking);
		const src = video.currentSrc || video.getAttribute("src") || "";
		const cancelProbe = src ? probeFrameRate(src, settle) : () => {};
		return () => {
			settled = true;
			cancelProbe();
			video.cancelVideoFrameCallback?.(handle);
			video.removeEventListener("seeking", onSeeking);
		};
	}, [video, clipId]);
	return fps;
}

interface PlaybackState {
	time: number;
	duration: number;
	paused: boolean;
	rate: number;
	muted: boolean;
}

function readState(video: HTMLVideoElement): PlaybackState {
	return { time: video.currentTime, duration: video.duration, paused: video.paused, rate: video.playbackRate, muted: video.muted };
}

/** Mirrors the element; a frame loop keeps the playhead smooth while playing. */
function usePlaybackState(video: HTMLVideoElement): PlaybackState {
	const [state, setState] = useState(() => readState(video));
	useEffect(() => {
		const sync = () => setState(readState(video));
		const events = ["timeupdate", "seeked", "seeking", "play", "pause", "durationchange", "loadedmetadata", "ratechange", "volumechange", "ended"];
		for (const name of events) video.addEventListener(name, sync);
		let raf = 0;
		const tick = () => {
			sync();
			raf = requestAnimationFrame(tick);
		};
		const startLoop = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
		const stopLoop = () => cancelAnimationFrame(raf);
		video.addEventListener("play", startLoop);
		video.addEventListener("pause", stopLoop);
		if (!video.paused) startLoop();
		sync();
		return () => {
			for (const name of events) video.removeEventListener(name, sync);
			video.removeEventListener("play", startLoop);
			video.removeEventListener("pause", stopLoop);
			stopLoop();
		};
	}, [video]);
	return state;
}

interface VideoReviewBarProps {
	video: HTMLVideoElement;
	fps: number | null;
	markers: VideoMarker[];
	activeMarkerId: string | null;
	onMarker: (id: string) => void;
	/** Absent where comments cannot be stored — the button is not drawn. */
	onComment?: () => void;
	/** Hold-to-repeat for the ±1 frame buttons; a plain step until it exists. */
	hold?: FrameStepHold | null;
	/** The spot-marking tool; absent where comments cannot be stored. */
	markerTool?: { active: boolean; onToggle: () => void };
}

/**
 * The video viewer's own transport: play, frame step, speed, mute and a
 * scrubber that carries the review comments as markers. It replaces the native
 * controls because a native scrubber cannot draw markers.
 */
export default function VideoReviewBar({ video, fps, markers, activeMarkerId, onMarker, onComment, hold = null, markerTool }: VideoReviewBarProps) {
	const t = useT();
	const state = usePlaybackState(video);
	const trackRef = useRef<HTMLDivElement>(null);
	const scrubbing = useRef(false);
	const keys = (id: string) => paletteShortcutKeys(id, isMac(), isRemote());
	const withKeys = (label: string, id: string) => {
		const combo = keys(id);
		return combo ? `${label} (${combo})` : label;
	};

	// While dragging, the thumb and readout follow the pointer, and hold the release
	// target until its seek is written; the picture follows as fast as seeks land.
	const [scrubTime, setScrubTime] = useState<number | null>(null);
	const seeker = useRef<ScrubSeeker | null>(null);
	useEffect(() => {
		const created = createScrubSeeker(video, () => { if (!scrubbing.current) setScrubTime(null); });
		seeker.current = created;
		return () => { created.dispose(); if (seeker.current === created) seeker.current = null; };
	}, [video]);

	const seekToPointer = useCallback((clientX: number) => {
		const track = trackRef.current;
		if (!track || !Number.isFinite(video.duration)) return;
		const rect = track.getBoundingClientRect();
		const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
		setScrubTime(ratio * video.duration);
		seeker.current?.seek(ratio * video.duration);
	}, [video]);
	const endScrub = () => {
		scrubbing.current = false;
		if (seeker.current?.target() == null) setScrubTime(null);
	};

	const onSliderKey = (e: React.KeyboardEvent) => {
		const steps: Record<string, number> = {
			ArrowRight: SEEK_STEP_SECONDS, ArrowUp: SEEK_STEP_SECONDS,
			ArrowLeft: -SEEK_STEP_SECONDS, ArrowDown: -SEEK_STEP_SECONDS,
			PageUp: PAGE_SEEK_SECONDS, PageDown: -PAGE_SEEK_SECONDS,
		};
		if (e.key in steps) seekVideoBy(video, steps[e.key]);
		else if (e.key === "Home") seekVideoToEdge(video, "start");
		else if (e.key === "End") seekVideoToEdge(video, "end");
		else return;
		e.preventDefault();
	};

	const shownTime = scrubTime ?? state.time;
	const played = timelinePercent(shownTime, state.duration);
	// The clip's end is past its last frame; never count one frame too many.
	const lastFrame = fps !== null ? lastFrameIndex(state.duration, fps) : null;
	const frame = fps !== null ? Math.min(frameAt(shownTime, fps), lastFrame ?? Number.POSITIVE_INFINITY) : null;
	const now = formatReviewTimestamp(shownTime);
	const total = Number.isFinite(state.duration) ? formatReviewTimestamp(state.duration) : "–:––";
	// Sized for the last frame, so a growing readout never shifts the timeline under a dragging pointer.
	const frameWidth = lastFrame !== null ? `${t("imageViewer.frameNumber", { frame: String(lastFrame) }).length}ch` : undefined;
	const iconBtn = "flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-fg-2 transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-elevated-hover hover:text-fg active:scale-[0.96]";
	const playLabel = state.paused ? t("imageViewer.videoPlay") : t("imageViewer.videoPause");

	const holdHandlers = (direction: 1 | -1) => {
		const release = () => hold?.release();
		return {
			onPointerDown: (e: React.PointerEvent) => {
				if (e.button !== 0) return;
				if (hold) hold.press(direction);
				else stepVideoFrame(video, direction, fps);
			},
			onPointerUp: release,
			onPointerLeave: release,
			onPointerCancel: release,
			// Enter / Space on a focused button: no pointer, so one plain step.
			onClick: (e: React.MouseEvent) => { if (e.detail === 0) stepVideoFrame(video, direction, fps); },
			// A long press on touch must not open the system menu mid-hold.
			onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
		};
	};
	const transportBtn = (props: {
		testId: string; label: string; shortcut?: string; keys?: string; glyph: string; big?: boolean; className?: string;
	} & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
		const { testId, label, shortcut, keys: ariaKeys, glyph, big, className = "", ...rest } = props;
		return (
			<button
				type="button"
				title={shortcut ? withKeys(label, shortcut) : label}
				aria-label={label}
				aria-keyshortcuts={ariaKeys}
				data-testid={testId}
				className={`${iconBtn} ${className}`}
				{...rest}
			>
				<span aria-hidden="true" className={`${big ? "text-base" : "text-sm"} leading-none`} style={{ fontFamily: ICON }}>{glyph}</span>
			</button>
		);
	};

	return (
		<div data-testid="video-review-bar" className="flex flex-shrink-0 flex-col border-t border-edge bg-raised px-3 pb-1.5">
			{/* Markers are a sibling layer, not children of the slider: ARIA makes a
			    slider's children presentational, which would hide them from screen readers. */}
			<div className="relative h-9 w-full">
				<div
					ref={trackRef}
					role="slider"
					tabIndex={0}
					aria-label={t("imageViewer.videoSeek")}
					aria-valuemin={0}
					aria-valuemax={Number.isFinite(state.duration) ? Math.round(state.duration) : 0}
					aria-valuenow={Math.round(shownTime)}
					aria-valuetext={`${now} / ${total}`}
					data-testid="video-scrubber"
					onKeyDown={onSliderKey}
					onPointerDown={(e) => {
						scrubbing.current = true;
						e.currentTarget.setPointerCapture?.(e.pointerId);
						seekToPointer(e.clientX);
					}}
					onPointerMove={(e) => { if (scrubbing.current) seekToPointer(e.clientX); }}
					onPointerUp={(e) => {
						if (scrubbing.current) seekToPointer(e.clientX);
						endScrub();
					}}
					onPointerCancel={endScrub}
					className="group absolute inset-x-0 bottom-0 h-6 cursor-pointer touch-none rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
				>
					<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-fg-muted/25">
						<div className="h-full bg-accent" style={{ width: `${played}%` }} />
					</div>
					<div
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_2px_rgb(var(--surface-raised)),0_1px_3px_rgb(0_0_0/0.35)] transition-transform group-hover:scale-110"
						style={{ left: `${played}%` }}
					/>
				</div>
				<div className="pointer-events-none absolute inset-x-0 top-0.5 h-3.5">
					{markers.map((marker) => {
						const active = marker.id === activeMarkerId;
						return (
							<button
								key={marker.id}
								type="button"
								title={marker.label}
								aria-label={marker.label}
								data-testid="video-marker"
								data-active={active ? "true" : undefined}
								onClick={() => onMarker(marker.id)}
								className="pointer-events-auto absolute top-0 flex h-full w-5 -translate-x-1/2 items-center justify-center outline-none focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-accent/60"
								style={{ left: `${timelinePercent(marker.time, state.duration)}%` }}
							>
								<span
									className={`block h-2 w-2 rotate-45 rounded-[2px] shadow-[0_0_0_1.5px_rgb(var(--surface-raised))] transition-transform ${
										marker.done ? "bg-fg-muted" : "bg-warning"
									} ${active ? "scale-125 ring-2 ring-accent" : ""}`}
								/>
							</button>
						);
					})}
				</div>
			</div>

			{/* Readout | transport (Play centred) | tools. Below `sm` the row wraps and
			    the ±5 frame buttons go first, so the transport fits a phone. */}
			<div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
				<span data-testid="video-time" className="order-2 flex-shrink-0 font-mono text-xs text-fg-2 tabular-nums sm:order-none sm:justify-self-start">
					<span className="inline-block text-right" style={{ minWidth: `${total.length}ch` }}>{now}</span><span className="text-fg-muted"> / {total}</span>
					{frame !== null && <span className="ml-2 inline-block text-fg-3" style={{ minWidth: frameWidth }}>{t("imageViewer.frameNumber", { frame: String(frame) })}</span>}
				</span>

				<div role="group" aria-label={t("imageViewer.transport")} data-testid="video-transport" className="order-1 flex flex-wrap items-center justify-center gap-0.5 sm:order-none">
					{transportBtn({ testId: "video-to-start", label: t("imageViewer.toStart"), shortcut: "media-seek-start", keys: "Home", glyph: "\uf049", onClick: () => seekVideoToEdge(video, "start") })}
					{transportBtn({ testId: "video-jump-back", label: t("imageViewer.jumpBack"), shortcut: "media-jump-back", keys: "j", glyph: "\u{f1946}", big: true, onClick: () => jumpVideo(video, -1) })}
					{transportBtn({ testId: "video-frames-back", label: t("imageViewer.framesBack", { count: String(FRAME_JUMP) }), glyph: "\uf04a", className: "max-sm:hidden", onClick: () => stepVideoFrame(video, -FRAME_JUMP, fps) })}
					{transportBtn({ testId: "video-frame-back", label: t("imageViewer.frameBack"), shortcut: "media-frame-back", keys: ",", glyph: "\uf048", className: "touch-none select-none", ...holdHandlers(-1) })}
					<button
						type="button"
						onClick={() => (video.paused ? void video.play().catch(() => {}) : video.pause())}
						title={playLabel}
						aria-label={playLabel}
						data-testid="video-play"
						className="mx-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-elevated text-fg transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-elevated-hover active:scale-[0.96]"
					>
						<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON }}>{state.paused ? "\uf04b" : "\uf04c"}</span>
					</button>
					{transportBtn({ testId: "video-frame-forward", label: t("imageViewer.frameForward"), shortcut: "media-frame-forward", keys: ".", glyph: "\uf051", className: "touch-none select-none", ...holdHandlers(1) })}
					{transportBtn({ testId: "video-frames-forward", label: t("imageViewer.framesForward", { count: String(FRAME_JUMP) }), glyph: "\uf04e", className: "max-sm:hidden", onClick: () => stepVideoFrame(video, FRAME_JUMP, fps) })}
					{transportBtn({ testId: "video-jump-forward", label: t("imageViewer.jumpForward"), shortcut: "media-jump-forward", keys: "l", glyph: "\u{f193a}", big: true, onClick: () => jumpVideo(video, 1) })}
					{transportBtn({ testId: "video-to-end", label: t("imageViewer.toEnd"), shortcut: "media-seek-end", keys: "End", glyph: "\uf050", onClick: () => seekVideoToEdge(video, "end") })}
				</div>

				<div className="order-3 flex flex-shrink-0 items-center gap-1 sm:justify-self-end">
					<label className="flex flex-shrink-0 items-center" title={`${t("imageViewer.playbackSpeed")} (${keys("media-speed-down")} / ${keys("media-speed-up")})`}>
						<span className="sr-only">{t("imageViewer.playbackSpeed")}</span>
						<select
							value={String(state.rate)}
							onChange={(e) => { video.playbackRate = Number(e.target.value); }}
							data-testid="video-speed"
							className="h-7 cursor-pointer rounded-md border border-edge bg-base px-1.5 font-mono text-xs text-fg-2 outline-none hover:border-edge-active focus-visible:ring-2 focus-visible:ring-accent/60"
						>
							{!PLAYBACK_RATES.some((rate) => rate === state.rate) && <option value={String(state.rate)}>{`${state.rate}×`}</option>}
							{PLAYBACK_RATES.map((rate) => (
								<option key={rate} value={String(rate)}>{`${rate}×`}</option>
							))}
						</select>
					</label>
					<button
						type="button"
						onClick={() => { video.muted = !video.muted; }}
						title={state.muted ? t("imageViewer.unmute") : t("imageViewer.mute")}
						aria-label={state.muted ? t("imageViewer.unmute") : t("imageViewer.mute")}
						aria-pressed={state.muted}
						data-testid="video-mute"
						className={iconBtn}
					>
						<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON }}>{state.muted ? "\uf026" : "\uf028"}</span>
					</button>
					{markerTool && (
						<button
							type="button"
							onClick={markerTool.onToggle}
							title={withKeys(t("imageViewer.markSpots"), "media-mark-spots")}
							aria-label={t("imageViewer.markSpots")}
							aria-pressed={markerTool.active}
							aria-keyshortcuts="m"
							data-testid="video-mark-spots"
							className={`${iconBtn} ${markerTool.active ? "bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent" : ""}`}
						>
							<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON }}>{"\uf05b"}</span>
						</button>
					)}
					{onComment && (
						<button
							type="button"
							onClick={onComment}
							title={withKeys(t("imageViewer.commentAtTime", { time: now }), "media-comment-at-playhead")}
							data-testid="video-comment"
							className="ml-1 inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 text-xs font-semibold text-accent transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-accent/15 active:scale-[0.96]"
						>
							<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON }}>{"\uf075"}</span>
							<span>{t("imageViewer.commentHere")}</span>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
