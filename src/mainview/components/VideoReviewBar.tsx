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

/** One frame in `direction`, paused — a frame step during playback is meaningless. */
export function stepVideoFrame(video: HTMLVideoElement, direction: 1 | -1, fps: number | null): void {
	const rate = fps ?? FALLBACK_FPS;
	video.pause();
	video.currentTime = frameSeekTime(frameAt(video.currentTime, rate) + direction, rate, video.duration);
}

export function stepVideoRate(video: HTMLVideoElement, direction: 1 | -1): void {
	video.playbackRate = stepPlaybackRate(video.playbackRate, direction);
}

export function seekVideoBy(video: HTMLVideoElement, seconds: number): void {
	const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
	video.currentTime = Math.min(end, Math.max(0, video.currentTime + seconds));
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
}

/**
 * The video viewer's own transport: play, frame step, speed, mute and a
 * scrubber that carries the review comments as markers. It replaces the native
 * controls because a native scrubber cannot draw markers.
 */
export default function VideoReviewBar({ video, fps, markers, activeMarkerId, onMarker, onComment }: VideoReviewBarProps) {
	const t = useT();
	const state = usePlaybackState(video);
	const trackRef = useRef<HTMLDivElement>(null);
	const scrubbing = useRef(false);
	const keys = (id: string) => paletteShortcutKeys(id, isMac(), isRemote());
	const withKeys = (label: string, id: string) => {
		const combo = keys(id);
		return combo ? `${label} (${combo})` : label;
	};

	/**
	 * While dragging, `fastSeek` jumps to the nearest keyframe — a precise seek per
	 * pointer move would decode a whole GOP each time on a long file. The release
	 * lands precisely.
	 */
	const seekToPointer = useCallback((clientX: number, precise: boolean) => {
		const track = trackRef.current;
		if (!track || !Number.isFinite(video.duration)) return;
		const rect = track.getBoundingClientRect();
		const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
		const target = ratio * video.duration;
		if (!precise && typeof video.fastSeek === "function") video.fastSeek(target);
		else video.currentTime = target;
	}, [video]);

	const onSliderKey = (e: React.KeyboardEvent) => {
		const steps: Record<string, number> = {
			ArrowRight: SEEK_STEP_SECONDS, ArrowUp: SEEK_STEP_SECONDS,
			ArrowLeft: -SEEK_STEP_SECONDS, ArrowDown: -SEEK_STEP_SECONDS,
			PageUp: PAGE_SEEK_SECONDS, PageDown: -PAGE_SEEK_SECONDS,
		};
		if (e.key in steps) seekVideoBy(video, steps[e.key]);
		else if (e.key === "Home") video.currentTime = 0;
		else if (e.key === "End" && Number.isFinite(video.duration)) video.currentTime = video.duration;
		else return;
		e.preventDefault();
	};

	const played = timelinePercent(state.time, state.duration);
	const frame = fps !== null ? frameAt(state.time, fps) : null;
	const now = formatReviewTimestamp(state.time);
	const total = Number.isFinite(state.duration) ? formatReviewTimestamp(state.duration) : "–:––";
	const iconBtn = "flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-fg-2 transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-elevated-hover hover:text-fg active:scale-[0.96]";
	const playLabel = state.paused ? t("imageViewer.videoPlay") : t("imageViewer.videoPause");

	return (
		<div data-testid="video-review-bar" className="flex flex-shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-t border-edge bg-raised px-3 py-1.5">
			<button
				type="button"
				onClick={() => (video.paused ? void video.play().catch(() => {}) : video.pause())}
				title={playLabel}
				aria-label={playLabel}
				data-testid="video-play"
				className={iconBtn}
			>
				<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON }}>{state.paused ? "\uf04b" : "\uf04c"}</span>
			</button>
			<button
				type="button"
				onClick={() => stepVideoFrame(video, -1, fps)}
				title={withKeys(t("imageViewer.frameBack"), "media-frame-back")}
				aria-label={t("imageViewer.frameBack")}
				aria-keyshortcuts=","
				data-testid="video-frame-back"
				className={iconBtn}
			>
				<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON }}>{"\uf048"}</span>
			</button>
			<button
				type="button"
				onClick={() => stepVideoFrame(video, 1, fps)}
				title={withKeys(t("imageViewer.frameForward"), "media-frame-forward")}
				aria-label={t("imageViewer.frameForward")}
				aria-keyshortcuts="."
				data-testid="video-frame-forward"
				className={iconBtn}
			>
				<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: ICON }}>{"\uf051"}</span>
			</button>
			<span data-testid="video-time" className="flex-shrink-0 px-1.5 font-mono text-xs text-fg-2 tabular-nums">
				{now}<span className="text-fg-muted"> / {total}</span>
				{frame !== null && <span className="ml-2 text-fg-3">{t("imageViewer.frameNumber", { frame: String(frame) })}</span>}
			</span>

			{/* Markers are a sibling layer, not children of the slider: ARIA makes a
			    slider's children presentational, which would hide them from screen readers. */}
			<div className="relative mx-2 h-10 min-w-[8rem] flex-1">
				<div
					ref={trackRef}
					role="slider"
					tabIndex={0}
					aria-label={t("imageViewer.videoSeek")}
					aria-valuemin={0}
					aria-valuemax={Number.isFinite(state.duration) ? Math.round(state.duration) : 0}
					aria-valuenow={Math.round(state.time)}
					aria-valuetext={`${now} / ${total}`}
					data-testid="video-scrubber"
					onKeyDown={onSliderKey}
					onPointerDown={(e) => {
						scrubbing.current = true;
						e.currentTarget.setPointerCapture?.(e.pointerId);
						seekToPointer(e.clientX, true);
					}}
					onPointerMove={(e) => { if (scrubbing.current) seekToPointer(e.clientX, false); }}
					onPointerUp={(e) => {
						if (scrubbing.current) seekToPointer(e.clientX, true);
						scrubbing.current = false;
					}}
					onPointerCancel={() => { scrubbing.current = false; }}
					className="group absolute inset-x-0 bottom-0 h-7 cursor-pointer touch-none rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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
				<div className="pointer-events-none absolute inset-x-0 top-0 h-3.5">
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
	);
}
