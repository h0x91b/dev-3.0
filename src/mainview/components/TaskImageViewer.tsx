import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDeletableSharedMedia, isSharedAudio, isSharedClip, taskSharedMedia, type SharedImage, type Task } from "../../shared/types";
import { clipReviewExcerpt, formatReviewMoment, nextFramePointNumber, videoMomentExcerpt, type ReviewComment, type ReviewFramePoint, type ReviewImageRegionAnchor, type ReviewVideoTimeAnchor } from "../../shared/review";
import { ReviewAside } from "../review/ReviewAside";
import { ImageRegionOverlay, pictureContentRect, regionLabel, type Region } from "../review/ImageRegionOverlay";
import { useReviewSend } from "../review/useReviewSend";
import { useTaskReview } from "../review/useTaskReview";
import { api } from "../rpc";
import { PopupBlockedError, openFileInBrowser } from "../file-open-browser";
import { isRemote } from "../utils/platform";
import { useT } from "../i18n";
import HelpSpot from "./HelpSpot";
import { toast } from "../toast";
import { usePinchZoom } from "../hooks/usePinchZoom";
import { useFocusTrap } from "../utils/useFocusTrap";
import { registerOverlayLayer } from "../utils/overlay-layers";
import { downloadDataUrl, downloadUrl } from "../utils/downloadBytes";
import ImageSaveMenu from "./ImageSaveMenu";
import Tooltip from "./Tooltip";
import VideoFrameThumb, { ClipPlayBadge } from "./VideoFrameThumb";
import { primeFirstFrame } from "../utils/video-first-frame";
import VideoReviewBar, { SEEK_STEP_SECONDS, jumpVideo, seekVideoBy, seekVideoToEdge, stepVideoFrame, stepVideoRate, useFrameStepHold, useVideoFrameRate, type VideoMarker } from "./VideoReviewBar";
import VideoFrameSpots, { containedPictureBox, type StageBox } from "./VideoFrameSpots";
import { frameAt, frameSeekTime, isAtMoment } from "../utils/video-playback";
import { captureFrameStill } from "../utils/frame-still";
import { matchesShortcut } from "../keymap";
import { confirmDeleteSharedMedia, useOlderClipsCleanup } from "../shared-media-delete";
import { formatBytes } from "../utils/formatBytes";

interface TaskImageViewerProps {
	images: SharedImage[];
	initialIndex: number;
	onClose: () => void;
	taskId?: string;
	/**
	 * Ids of the images that were still unread when the viewer opened. Opening
	 * marks them read server-side, so the caller freezes the set and keeps it for
	 * the viewer's lifetime — that is what "highlighted until you close it" means.
	 */
	newIds?: string[];
	/** The owning project; without it comments cannot be stored, so comment mode stays hidden. */
	projectId?: string;
	/** The live task record when the host has it — its `review` is what the regions are drawn from. */
	task?: Pick<Task, "id" | "review">;
}

const ICON = "'JetBrainsMono Nerd Font Mono'";
const AUDIO_GLYPH = "\uf001";

function clipErrorKey(clip: "video" | "audio" | null, loadFailed: boolean) {
	if (clip === "audio") return loadFailed ? "imageViewer.audioLoadError" : "imageViewer.audioUnsupported";
	if (clip === "video") return loadFailed ? "imageViewer.videoLoadError" : "imageViewer.videoUnsupported";
	return "imageViewer.loadError";
}
/** A clip's rail tile before (or without) a captured frame: its glyph on black. */
function ClipThumbGlyph({ clip, title }: { clip: "video" | "audio"; title: string }) {
	return (
		<span
			data-testid={`viewer-thumb-${clip}`}
			title={title}
			className="flex h-full w-full items-center justify-center bg-black/80 text-white text-lg"
			style={{ fontFamily: ICON }}
		>
			{clip === "audio" ? AUDIO_GLYPH : "\uf04b"}
		</span>
	);
}

/** A PNG of the frame with its spots, saved where the agent can open it; null when the engine refuses. */
async function saveFrameStill(projectId: string, clipName: string, url: string, time: number, spots: ReviewFramePoint[]): Promise<string | null> {
	try {
		const base64 = await captureFrameStill(url, time, spots);
		if (!base64) return null;
		const stem = clipName.replace(/\.[^.]+$/, "");
		const saved = await api.request.uploadImageBase64({ projectId, base64, filename: `${stem}-${Math.round(time * 1000)}ms-spots.png`, mimeType: "image/png" });
		return saved?.path ?? null;
	} catch {
		return null;
	}
}

/** The playhead while the clip is paused (a seek counts as paused there); null while playing. */
function usePausedTime(video: HTMLVideoElement | null): number | null {
	const [time, setTime] = useState<number | null>(null);
	useEffect(() => {
		if (!video) { setTime(null); return; }
		const sync = () => setTime(video.paused ? video.currentTime : null);
		const events = ["play", "pause", "seeking", "seeked", "loadedmetadata", "ended"];
		for (const name of events) video.addEventListener(name, sync);
		sync();
		return () => { for (const name of events) video.removeEventListener(name, sync); };
	}, [video]);
	return time;
}

// Above this height/width ratio an image is "tall" (e.g. a full-page capture) —
// object-contain would squash it into a useless sliver, so we default such
// images to fill-width + vertical scroll instead.
const TALL_RATIO = 2.2;

/**
 * Windowed lightbox for images an agent surfaced via `dev3 show-image`. It is a
 * centred modal card that fills ~90% of the viewport (≈5% margin each side) —
 * deliberately NOT a full-bleed takeover — so it reads as part of the current
 * task; a fullscreen toggle expands it edge-to-edge for detailed viewing. Shows
 * one large image with a thumbnail history rail; images that were unread when
 * the viewer opened stay ringed in green for as long as it is open, and the
 * caller opens on the FIRST of them so a batch of three is read in order.
 * Bytes are fetched
 * lazily through the existing `readImageBase64` RPC, so it works identically in
 * the desktop shell and the remote browser. Pure React overlay — no native
 * dialog (project rule).
 *
 * A `dev3 show-media` clip swaps the stage for a `<video controls>` or
 * `<audio controls>` player that never autoplays; it streams from a
 * `getSharedMediaUrl` capability URL with Range requests, so a clip of hundreds
 * of MB is never held in memory.
 *
 * While open it marks <html data-image-viewer="open">, which hides the ghostty
 * WebGL terminal canvas behind it (index.css). In WKWebView a WebGL canvas is
 * promoted to a hardware overlay plane that paints ABOVE any DOM scrim, so
 * without this the live terminal would shine through around the card.
 */
export default function TaskImageViewer({ images, initialIndex, onClose, taskId, newIds, projectId, task }: TaskImageViewerProps) {
	const t = useT();
	const newSet = useMemo(() => new Set(newIds ?? []), [newIds]);
	const newCount = newSet.size;
	const [index, setIndex] = useState(() => Math.max(0, Math.min(images.length - 1, initialIndex)));
	// Cache of image id → data URL, or the streaming URL for a video ("__error__" marks a failed load).
	const [urls, setUrls] = useState<Record<string, string>>({});
	// The player's own failure (codec / container the engine cannot decode).
	const [clipError, setClipError] = useState(false);
	const [copied, setCopied] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	// Our own right-click menu over the image: WKWebView's native "Save Image As…"
	// does nothing useful here (same reason the artifact viewer injects its own).
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	// Natural size of the active image (from onLoad) → drives the tall-image default.
	const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
	// null = auto (decide from aspect ratio); otherwise a manual override.
	const [fitOverride, setFitOverride] = useState<"fit" | "width" | null>(null);
	const containerRef = useFocusTrap<HTMLDivElement>();
	// Comment mode: drag a region over the picture, comment on it beside the
	// picture. Regions are normalised to the drawn image, so they survive zoom,
	// fit mode and viewport; the comments live on the task record like every
	// other review comment.
	const reviewTask = useMemo<Pick<Task, "id" | "review">>(() => task ?? { id: taskId ?? "" }, [task, taskId]);
	const review = useTaskReview(reviewTask, projectId ?? "");
	const send = useReviewSend(taskId ?? "", projectId, review);
	const canComment = Boolean(projectId && taskId);
	const [commentMode, setCommentMode] = useState(false);
	const [pendingRegion, setPendingRegion] = useState<Region | null>(null);
	const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	// The drawn picture's box relative to the stage, re-measured whenever the
	// image or the layout changes; the overlay sits exactly on it.
	const [pictureBox, setPictureBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
	const thumbStripRef = useRef<HTMLDivElement>(null);
	const playerRef = useRef<HTMLMediaElement | null>(null);
	// The video element as state: the transport bar and the frame-rate meter
	// subscribe to it, so they must re-run when the clip on stage changes.
	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	const attachVideo = useCallback((node: HTMLVideoElement | null) => {
		playerRef.current = node;
		setVideoEl(node);
	}, []);
	// A moment picked for a video comment, waiting for its text.
	const [pendingMoment, setPendingMoment] = useState<Pick<ReviewVideoTimeAnchor, "time" | "frame" | "fps"> | null>(null);
	// Numbered spots of the comment being written, and the tool that places them.
	const [draftSpots, setDraftSpots] = useState<ReviewFramePoint[]>([]);
	const [spotTool, setSpotTool] = useState(false);
	const [selectedSpot, setSelectedSpot] = useState<number | null>(null);
	const clearSpots = useCallback(() => { setDraftSpots([]); setSpotTool(false); setSelectedSpot(null); }, []);
	// Comments whose frame still is being captured and saved; nothing sends them meanwhile.
	const [stillsInFlight, setStillsInFlight] = useState<string[]>([]);
	// A short line over the stage: the lightbox sits above the app's toast layer.
	const [stageHint, setStageHint] = useState<string | null>(null);
	useEffect(() => {
		if (!stageHint) return;
		const timer = setTimeout(() => setStageHint(null), 3000);
		return () => clearTimeout(timer);
	}, [stageHint]);
	// The drawn video element, relative to the stage; the spots sit on its picture.
	const [videoBox, setVideoBox] = useState<StageBox | null>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	// Ids whose fetch has already been kicked off — dedupes the priority effect
	// against the background loader so each image is read at most once.
	const startedRef = useRef<Set<string>>(new Set());
	const mountedRef = useRef(true);
	useEffect(() => () => { mountedRef.current = false; }, []);
	// Records this viewer changed (deleted, pinned), shown at once even when the host's list is a snapshot.
	const [overrides, setOverrides] = useState<Record<string, SharedImage>>({});
	const media = useMemo(() => images.map((item) => overrides[item.id] ?? item), [images, overrides]);
	const cleanup = useOlderClipsCleanup({ projectId, taskId, media, t });

	// Keep the active index valid when the image list changes (new arrivals).
	useEffect(() => {
		setIndex((i) => Math.max(0, Math.min(images.length - 1, i)));
	}, [images.length]);

	const current = media[index];
	const isRemoved = Boolean(current?.removedAt);
	const clip = current && isSharedClip(current) ? (isSharedAudio(current) ? "audio" : "video") : null;
	const isClip = clip !== null;
	const hasClips = useMemo(() => images.some(isSharedClip), [images]);
	// Aspect-driven display mode: tall captures scroll vertically ("width"),
	// everything else is centred + contained ("fit") and gets pinch-to-zoom.
	const isTall = natural ? natural.h / natural.w >= TALL_RATIO : false;
	const fit: "fit" | "width" = fitOverride ?? (isTall ? "width" : "fit");
	const zoom = usePinchZoom(fit === "fit" && !commentMode && !isClip);
	const imageComments = useMemo(
		() => (current ? review.comments.filter((comment) => comment.anchor.kind === "image-region" && comment.anchor.imageId === current.id) : []),
		[current, review.comments],
	);
	const videoComments = useMemo(
		() => (current && clip === "video"
			? review.comments
				.filter((comment) => comment.anchor.kind === "video-time" && comment.anchor.imageId === current.id)
				.sort((a, b) => (a.anchor as ReviewVideoTimeAnchor).time - (b.anchor as ReviewVideoTimeAnchor).time)
			: []),
		[current, clip, review.comments],
	);
	const fps = useVideoFrameRate(clip === "video" ? videoEl : null, current?.id ?? null);
	const frameHold = useFrameStepHold(clip === "video" ? videoEl : null, fps);
	const pausedTime = usePausedTime(clip === "video" ? videoEl : null);
	const commentAtPlayhead = useCallback(() => {
		const video = playerRef.current;
		if (!canComment || clip !== "video" || !(video instanceof HTMLVideoElement)) return;
		video.pause();
		const time = video.currentTime;
		setPendingMoment({ time, frame: fps === null ? null : frameAt(time, fps), fps });
		setActiveCommentId(null);
		setCommentMode(true);
	}, [canComment, clip, fps]);
	const seekToComment = useCallback((id: string) => {
		setActiveCommentId(id);
		const comment = videoComments.find((item) => item.id === id);
		const video = playerRef.current;
		if (!comment || !(video instanceof HTMLVideoElement)) return;
		const anchor = comment.anchor as ReviewVideoTimeAnchor;
		video.pause();
		video.currentTime = anchor.frame !== null && anchor.fps ? frameSeekTime(anchor.frame, anchor.fps, video.duration) : anchor.time;
	}, [videoComments]);
	const markers = useMemo<VideoMarker[]>(() => videoComments.map((comment, i) => {
		const anchor = comment.anchor as ReviewVideoTimeAnchor;
		return {
			id: comment.id,
			time: anchor.time,
			label: t("imageViewer.videoMarker", { n: String(i + 1), time: formatReviewMoment(anchor), body: clipReviewExcerpt(comment.body, 80) }),
			done: Boolean(comment.sentAt || comment.resolvedAt),
		};
	}), [videoComments, t]);
	// Spots belong to the draft's frame, which never moves. Off that frame the
	// tool first brings the playhead back to it; a spot is placed only on it.
	const returnToDraftFrame = useCallback((video: HTMLVideoElement): boolean => {
		video.pause();
		if (!pendingMoment || isAtMoment(video.currentTime, pendingMoment, fps)) return false;
		video.currentTime = pendingMoment.frame !== null && pendingMoment.fps ? frameSeekTime(pendingMoment.frame, pendingMoment.fps, video.duration) : pendingMoment.time;
		setStageHint(t("imageViewer.spotsBackToDraft", { time: formatReviewMoment(pendingMoment) }));
		return true;
	}, [pendingMoment, fps, t]);
	const toggleSpotTool = useCallback(() => {
		const video = playerRef.current;
		if (!canComment || clip !== "video" || !(video instanceof HTMLVideoElement)) return;
		if (spotTool) { setSpotTool(false); setSelectedSpot(null); return; }
		if (pendingMoment) returnToDraftFrame(video);
		else commentAtPlayhead();
		setSpotTool(true);
	}, [canComment, clip, spotTool, pendingMoment, commentAtPlayhead, returnToDraftFrame]);
	const addSpot = useCallback((spot: { x: number; y: number }) => {
		const video = playerRef.current;
		if (!(video instanceof HTMLVideoElement)) return;
		if (!pendingMoment) {
			const time = video.currentTime;
			setPendingMoment({ time, frame: fps === null ? null : frameAt(time, fps), fps });
			setActiveCommentId(null);
			setCommentMode(true);
		} else if (returnToDraftFrame(video)) return;
		setDraftSpots((prev) => [...prev, { n: nextFramePointNumber(prev), ...spot }]);
		setSelectedSpot(null);
	}, [pendingMoment, fps, returnToDraftFrame]);
	const removeSpot = useCallback((n: number) => {
		setDraftSpots((prev) => prev.filter((point) => point.n !== n));
		setSelectedSpot(null);
	}, []);
	const measureVideo = useCallback(() => {
		const video = videoEl;
		const stage = stageRef.current;
		if (!video || !stage) { setVideoBox(null); return; }
		const rect = video.getBoundingClientRect();
		const host = stage.getBoundingClientRect();
		const element = { left: rect.left - host.left + stage.scrollLeft, top: rect.top - host.top + stage.scrollTop, width: rect.width, height: rect.height };
		setVideoBox(containedPictureBox(element, video.videoWidth > 0 ? { w: video.videoWidth, h: video.videoHeight } : null));
	}, [videoEl]);
	useEffect(() => {
		measureVideo();
		const stage = stageRef.current;
		if (!videoEl || !stage) return;
		videoEl.addEventListener("loadedmetadata", measureVideo);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureVideo);
		observer?.observe(stage);
		observer?.observe(videoEl);
		return () => {
			observer?.disconnect();
			videoEl.removeEventListener("loadedmetadata", measureVideo);
		};
	}, [measureVideo, videoEl, fullscreen, commentMode]);
	const showDraftSpots = pausedTime !== null && draftSpots.length > 0 && pendingMoment !== null && isAtMoment(pausedTime, pendingMoment, fps);
	const savedSpots = useMemo(() => {
		if (pausedTime === null) return [];
		return videoComments.flatMap((comment) => {
			const anchor = comment.anchor as ReviewVideoTimeAnchor;
			if (!anchor.points?.length || !isAtMoment(pausedTime, anchor, fps)) return [];
			return [{ commentId: comment.id, points: anchor.points, active: comment.id === activeCommentId }];
		});
	}, [pausedTime, videoComments, fps, activeCommentId]);
	const showSpots = clip === "video" && videoBox !== null && pausedTime !== null && (spotTool || showDraftSpots || savedSpots.length > 0);

	const measurePicture = useCallback(() => {
		const img = imgRef.current;
		const stage = stageRef.current;
		if (!img || !stage) { setPictureBox(null); return; }
		const rect = pictureContentRect(img, fit === "width");
		const host = stage.getBoundingClientRect();
		setPictureBox({ left: rect.left - host.left + stage.scrollLeft, top: rect.top - host.top + stage.scrollTop, width: rect.width, height: rect.height });
	}, [fit]);
	useEffect(() => {
		measurePicture();
		const stage = stageRef.current;
		if (!stage || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measurePicture);
		observer.observe(stage);
		if (imgRef.current) observer.observe(imgRef.current);
		stage.addEventListener("scroll", measurePicture);
		return () => {
			observer.disconnect();
			stage.removeEventListener("scroll", measurePicture);
		};
	}, [measurePicture, natural, fullscreen, commentMode, urls, index]);
	useEffect(() => {
		if (commentMode) zoom.reset();
	}, [commentMode, zoom.reset]);
	const setStage = useCallback((el: HTMLDivElement | null) => {
		stageRef.current = el;
		zoom.setNode(el);
	}, [zoom.setNode]);

	// Fetch one image's bytes as a data URL, once. Marks "__error__" on failure so
	// the thumbnail/stage renders a placeholder instead of a perpetual spinner.
	const loadImage = useCallback(async (img: SharedImage) => {
		if (startedRef.current.has(img.id)) return;
		startedRef.current.add(img.id);
		let dataUrl = "__error__";
		try {
			const res = isSharedClip(img)
				? await api.request.getSharedMediaUrl({ path: img.storedPath }).then((r) => r && { dataUrl: r.url })
				: await api.request.readImageBase64({ path: img.storedPath });
			dataUrl = res?.dataUrl ?? "__error__";
		} catch {
			dataUrl = "__error__";
		}
		if (mountedRef.current) setUrls((prev) => ({ ...prev, [img.id]: dataUrl }));
	}, []);

	// Priority: the active image and its immediate neighbours load first so
	// stepping through the rail feels instant.
	useEffect(() => {
		for (const j of [index, index + 1, index - 1]) {
			if (j < 0 || j >= images.length) continue;
			// A clip is read only when it is the one on stage — its bytes dwarf an image's.
			if (j !== index && isSharedClip(images[j])) continue;
			void loadImage(images[j]);
		}
	}, [index, images, loadImage]);

	// Background: eagerly load EVERY image (concurrency-capped) so the thumbnail
	// rail always shows a real picture — never a lazy placeholder that only fills
	// in as you scrub. The dedupe set skips anything the priority effect grabbed.
	useEffect(() => {
		let cancelled = false;
		const pending = images.filter((im) => !startedRef.current.has(im.id) && !isSharedClip(im));
		let cursor = 0;
		const CONCURRENCY = 4;
		async function worker() {
			while (!cancelled) {
				const img = pending[cursor++];
				if (!img) return;
				await loadImage(img);
			}
		}
		for (let i = 0; i < Math.min(CONCURRENCY, pending.length); i++) void worker();
		return () => { cancelled = true; };
	}, [images, loadImage]);

	const go = useCallback((delta: number) => {
		setIndex((i) => Math.max(0, Math.min(images.length - 1, i + delta)));
	}, [images.length]);

	// Hide the WebGL terminal behind the viewer (see the class docstring).
	useEffect(() => {
		const el = document.documentElement;
		el.setAttribute("data-image-viewer", "open");
		return () => el.removeAttribute("data-image-viewer");
	}, []);

	// Escape is owned by the overlay-layer stack, not by a listener of our own: a
	// modal that opened this lightbox (the archived task modal) registered its
	// capture-phase Escape first and stops immediate propagation, so a private
	// listener here would never run and the modal underneath would close instead.
	// Registering as a layer puts us at the top of that unwind order.
	const dismissRef = useRef<() => void>(() => {});
	dismissRef.current = () => {
		if (menu) setMenu(null);
		else if (commentMode) { setCommentMode(false); setPendingRegion(null); setPendingMoment(null); clearSpots(); }
		else if (fullscreen) setFullscreen(false);
		else onClose();
	};
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		return registerOverlayLayer(el, () => dismissRef.current());
	// The container element identity is stable for the lightbox's lifetime.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const heldFrameKey = useRef<string | null>(null);
	// Keyboard navigation + f = fullscreen. Capture phase + stopPropagation
	// because this lightbox is a modal that owns the keyboard while open: the
	// App-level Escape listener is registered first and would otherwise navigate
	// out of the task workspace behind it (decision 181).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const consume = () => { e.preventDefault(); e.stopPropagation(); };
			const target = e.target instanceof HTMLElement ? e.target : null;
			// A focused player owns its arrows (seek) and Space (play/pause).
			if ((target?.tagName === "VIDEO" || target?.tagName === "AUDIO") && (e.key.startsWith("Arrow") || e.key === " " || e.key === "Home" || e.key === "End")) return;
			if (e.key === " " && playerRef.current && !target?.closest("button, input, textarea, select, [contenteditable='true']")) {
				consume();
				const player = playerRef.current;
				if (player.paused) void player.play().catch(() => {});
				else player.pause();
				return;
			}
			// A focused comment field owns its own text (typing "f" or using arrow
			// keys to move the cursor must not fall through to lightbox navigation).
			if (target?.closest("input, textarea, [contenteditable='true']")) return;
			// The scrubber and the speed menu own their arrows and Home/End.
			if (target?.closest("[role='slider'], select") && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) return;
			const video = playerRef.current instanceof HTMLVideoElement ? playerRef.current : null;
			if (video) {
				// The viewer is itself a dialog, which the matcher reads as "typing"; text
				// fields already returned above, and the speed menu has no use for , . < > c j l.
				const ctx = { typing: false };
				// A held key repeats at the hold's own rate, not the OS key-repeat rate.
				const frameKey = matchesShortcut(e, "media-frame-back", ctx) ? -1 : matchesShortcut(e, "media-frame-forward", ctx) ? 1 : 0;
				if (frameKey !== 0) {
					consume();
					if (e.repeat) return;
					if (frameHold) { heldFrameKey.current = e.code; frameHold.press(frameKey); }
					else stepVideoFrame(video, frameKey, fps);
					return;
				}
				if (matchesShortcut(e, "media-seek-start", ctx)) { consume(); seekVideoToEdge(video, "start"); return; }
				if (matchesShortcut(e, "media-seek-end", ctx)) { consume(); seekVideoToEdge(video, "end"); return; }
				if (canComment && matchesShortcut(e, "media-mark-spots", ctx)) { consume(); toggleSpotTool(); return; }
				if (matchesShortcut(e, "media-jump-back", ctx)) { consume(); jumpVideo(video, -1); return; }
				if (matchesShortcut(e, "media-jump-forward", ctx)) { consume(); jumpVideo(video, 1); return; }
				if (matchesShortcut(e, "media-speed-down", ctx)) { consume(); stepVideoRate(video, -1); return; }
				if (matchesShortcut(e, "media-speed-up", ctx)) { consume(); stepVideoRate(video, 1); return; }
				if (canComment && matchesShortcut(e, "media-comment-at-playhead", ctx)) { consume(); commentAtPlayhead(); return; }
				// Arrows seek a video instead of leaving it: moving to another item would
				// remount the clip at 0:00. The chevrons and the rail still change items.
				if (e.key === "ArrowRight") { consume(); seekVideoBy(video, SEEK_STEP_SECONDS); return; }
				if (e.key === "ArrowLeft") { consume(); seekVideoBy(video, -SEEK_STEP_SECONDS); return; }
			}
			if (e.key === "ArrowRight") { consume(); go(1); }
			else if (e.key === "ArrowLeft") { consume(); go(-1); }
			else if (e.key === "Home") { consume(); setIndex(0); }
			else if (e.key === "End") { consume(); setIndex(images.length - 1); }
			else if (e.key === "f" || e.key === "F") { consume(); setFullscreen((v) => !v); }
		}
		function onKeyUp(e: KeyboardEvent) {
			if (heldFrameKey.current !== e.code) return;
			heldFrameKey.current = null;
			frameHold?.release();
		}
		window.addEventListener("keydown", onKey, { capture: true });
		window.addEventListener("keyup", onKeyUp, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKey, { capture: true });
			window.removeEventListener("keyup", onKeyUp, { capture: true });
		};
	}, [go, onClose, images.length, fullscreen, fps, canComment, commentAtPlayhead, frameHold, toggleSpotTool]);

	// Reset per-image derived state and scroll the active thumbnail into view.
	useEffect(() => {
		const strip = thumbStripRef.current;
		const active = strip?.querySelector<HTMLElement>(`[data-thumb-index="${index}"]`);
		active?.scrollIntoView({ inline: "center", block: "nearest" });
		setCopied(false);
		setMenu(null);
		setNatural(null);
		setFitOverride(null);
		setPendingRegion(null);
		setPendingMoment(null);
		clearSpots();
		setActiveCommentId(null);
		setClipError(false);
		zoom.reset();
		if (stageRef.current) stageRef.current.scrollTop = 0;
	}, [index, zoom.reset, clearSpots]);

	if (!current) return null;

	const currentUrl = urls[current.id];
	const isError = currentUrl === "__error__";

	const copyPath = async () => {
		try {
			await navigator.clipboard.writeText(current.storedPath);
			setCopied(true);
		} catch {
			toast.error(t("imageViewer.copyFailed"), { taskId });
		}
	};

	// Renderer-side anchor download (Electrobun → ~/Downloads, browser → its own
	// download dir). An image is already here as a data URL; a clip is streamed, so
	// its bytes are fetched only now, on an explicit click.
	const saveImage = async () => {
		setMenu(null);
		if (!currentUrl || isError || isRemoved) return;
		try {
			if (isClip) await downloadUrl(currentUrl, current.name);
			else downloadDataUrl(currentUrl, current.name);
			toast.success(t(clip === "audio" ? "imageViewer.audioSaved" : clip === "video" ? "imageViewer.videoSaved" : "imageViewer.saved"), { taskId });
		} catch {
			toast.error(t(clip === "audio" ? "imageViewer.audioSaveFailed" : clip === "video" ? "imageViewer.videoSaveFailed" : "imageViewer.saveFailed"), { taskId });
		}
	};

	const canDelete = Boolean(projectId && taskId) && isDeletableSharedMedia(current);
	const canPin = Boolean(projectId && taskId) && !isRemoved;
	const togglePin = async () => {
		setMenu(null);
		if (!projectId || !taskId) return;
		try {
			const updated = await api.request.setSharedMediaPinned({ projectId, taskId, mediaId: current.id, pinned: !current.pinnedAt });
			const record = taskSharedMedia(updated).find((item) => item.id === current.id);
			if (record && mountedRef.current) setOverrides((prev) => ({ ...prev, [record.id]: record }));
		} catch {
			toast.error(t("sharedMedia.pinFailed"), { taskId });
		}
	};
	const deleteCurrent = async () => {
		setMenu(null);
		if (!projectId || !taskId) return;
		playerRef.current?.pause();
		const updated = await confirmDeleteSharedMedia({ projectId, taskId, items: [current], t, scope: "one" });
		const record = updated && taskSharedMedia(updated).find((item) => item.id === current.id);
		if (record?.removedAt && mountedRef.current) setOverrides((prev) => ({ ...prev, [record.id]: record }));
	};
	const deleteOlder = async () => {
		setMenu(null);
		const ids = new Set(cleanup.older.map((item) => item.id));
		if (ids.has(current.id)) playerRef.current?.pause();
		const updated = await cleanup.run();
		if (!updated || !mountedRef.current) return;
		const records = taskSharedMedia(updated).filter((item) => ids.has(item.id) && item.removedAt);
		setOverrides((prev) => ({ ...prev, ...Object.fromEntries(records.map((item) => [item.id, item])) }));
	};

	const openMenu = (e: React.MouseEvent) => {
		if ((!currentUrl || isError) && !canDelete && !canPin && !cleanup.available) return;
		e.preventDefault();
		setMenu({ x: e.clientX, y: e.clientY });
	};

	const iconBtn = "flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 hover:bg-elevated-hover hover:text-fg transition-colors";

	const addRegionComment = (body: string, andSend: boolean) => {
		if (!pendingRegion || !current) return;
		const anchor: ReviewImageRegionAnchor = {
			kind: "image-region",
			imageId: current.id,
			name: current.name,
			path: current.storedPath,
			caption: current.caption ? clipReviewExcerpt(current.caption) : null,
			...pendingRegion,
		};
		const comment: ReviewComment = { id: crypto.randomUUID(), body, createdAt: new Date().toISOString(), anchor };
		review.add(comment);
		setPendingRegion(null);
		setActiveCommentId(comment.id);
		if (andSend) send.sendOne(comment);
	};
	const addMomentComment = async (body: string, andSend: boolean) => {
		if (!pendingMoment || !current) return;
		const moment = pendingMoment;
		const spots = [...draftSpots].sort((a, b) => a.n - b.n);
		const clipUrl = currentUrl;
		setPendingMoment(null);
		clearSpots();
		const anchor: ReviewVideoTimeAnchor = {
			kind: "video-time",
			imageId: current.id,
			name: current.name,
			path: current.storedPath,
			caption: current.caption ? clipReviewExcerpt(current.caption) : null,
			...moment,
			excerpt: videoMomentExcerpt(current.name, moment),
			...(spots.length > 0 ? { points: spots } : {}),
		};
		const comment: ReviewComment = { id: crypto.randomUUID(), body, createdAt: new Date().toISOString(), anchor };
		// The comment shows at once; the still (a decode, an encode and an upload) is patched in after.
		const added = review.add(comment);
		setActiveCommentId(comment.id);
		if (spots.length === 0 || !clipUrl || !projectId) {
			if (andSend) send.sendOne(comment);
			return;
		}
		setStillsInFlight((ids) => [...ids, comment.id]);
		let still: string | null = null;
		try {
			const [stored, saved] = await Promise.all([added, saveFrameStill(projectId, current.name, clipUrl, moment.time, spots)]);
			still = stored ? saved : null;
			if (still) await review.setStill(comment.id, still);
		} finally {
			setStillsInFlight((ids) => ids.filter((id) => id !== comment.id));
		}
		// Send now waits for the still, so the agent gets the picture with the message.
		if (andSend) send.sendOne(still ? { ...comment, anchor: { ...anchor, still } } : comment);
	};
	// While a still is on its way, its comment counts as sending and send-all waits,
	// so no comment reaches the agent without the frame it points at.
	const videoSend = useMemo(() => (stillsInFlight.length === 0 ? send : {
		...send,
		sendingCommentIds: { ...send.sendingCommentIds, ...Object.fromEntries(stillsInFlight.map((id) => [id, true])) },
	}), [send, stillsInFlight]);
	const stageStatus = stageHint ?? (stillsInFlight.length > 0 ? t("imageViewer.savingFrame") : null);
	const showOverlay = !isClip && canComment && pictureBox && currentUrl && !isError && (commentMode || imageComments.length > 0);
	const copyLabel = t(clip === "audio" ? "imageViewer.copyAudioPath" : clip === "video" ? "imageViewer.copyVideoPath" : "imageViewer.copyPath");
	const downloadLabel = t(clip === "audio" ? "imageViewer.downloadAudio" : clip === "video" ? "imageViewer.downloadVideo" : "imageViewer.download");

	return (
		<div
			className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/60 outline-none ${fullscreen ? "p-0" : "px-[5vw] py-[5vh]"}`}
			onClick={onClose}
		>
			<div
				ref={containerRef}
				role="dialog"
				aria-modal="true"
				aria-label={t(hasClips ? "imageViewer.titleMedia" : "imageViewer.title")}
				tabIndex={-1}
				className={`relative flex flex-col overflow-hidden bg-elevated outline-none ${
					fullscreen
						? "w-full h-full rounded-none"
						: "w-full h-full max-w-[2400px] max-h-[1600px] rounded-2xl border border-edge shadow-2xl"
				}`}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header: name / caption / counter / actions */}
				<div className="flex items-center gap-2 px-4 py-2.5 text-sm text-fg-2 border-b border-edge bg-raised">
					<div className="min-w-0 flex-1">
						<div className="truncate text-fg font-medium" title={current.originalPath}>{current.name}</div>
					</div>
					{current.pinnedAt && !isRemoved && (
						<span data-testid="image-viewer-kept" title={t("sharedMedia.keptHint")} className="flex-shrink-0 rounded-full border border-edge px-2 py-0.5 text-micro font-semibold text-fg-2">
							<span className="mr-1" style={{ fontFamily: ICON }}>{"\uf08d"}</span>{t("sharedMedia.kept")}
						</span>
					)}
					{newCount > 0 && (
						<span
							data-testid="image-viewer-new-count"
							className="flex-shrink-0 rounded-full border border-success/40 bg-success/15 px-2 py-0.5 text-micro font-semibold text-success tabular-nums"
						>
							{t.plural("imageViewer.newCount", newCount)}
						</span>
					)}
					<span className="flex-shrink-0 font-mono text-xs text-fg-3 tabular-nums">
						{index + 1} / {images.length}
					</span>
					<HelpSpot topicId="viewer.images" />
					{isTall && !isClip && (
						<button
							type="button"
							onClick={() => setFitOverride(fit === "width" ? "fit" : "width")}
							title={fit === "width" ? t("imageViewer.fitScreen") : t("imageViewer.fitWidth")}
							aria-label={fit === "width" ? t("imageViewer.fitScreen") : t("imageViewer.fitWidth")}
							className={iconBtn}
						>
							<span className="text-base leading-none" style={{ fontFamily: ICON }}>{fit === "width" ? "" : ""}</span>
						</button>
					)}
					{canComment && clip !== "audio" && (
						<button
							type="button"
							onClick={() => { setCommentMode((on) => !on); setPendingRegion(null); setPendingMoment(null); }}
							title={t(clip === "video" ? "imageViewer.videoCommentMode" : "imageViewer.commentMode")}
							aria-label={t(clip === "video" ? "imageViewer.videoCommentMode" : "imageViewer.commentMode")}
							aria-pressed={commentMode}
							data-testid="image-viewer-comment"
							className={`${iconBtn} ${commentMode ? "bg-accent/10 text-accent" : ""}`}
						>
							<span className="text-base leading-none" style={{ fontFamily: ICON }}>{"\uf075"}</span>
						</button>
					)}
					<button
						type="button"
						onClick={() => setFullscreen((v) => !v)}
						title={fullscreen ? t("imageViewer.exitFullscreen") : t("imageViewer.enterFullscreen")}
						aria-label={fullscreen ? t("imageViewer.exitFullscreen") : t("imageViewer.enterFullscreen")}
						data-testid="image-viewer-fullscreen"
						className={iconBtn}
					>
						<span className="text-base leading-none" style={{ fontFamily: ICON }}>{fullscreen ? "" : ""}</span>
					</button>
					<button
						type="button"
						onClick={copyPath}
						disabled={isRemoved}
						title={copyLabel}
						aria-label={copyLabel}
						data-testid="image-viewer-copy-path"
						className={`${iconBtn} disabled:opacity-40 disabled:cursor-default`}
					>
						<span className={`text-base leading-none ${copied ? "text-success" : ""}`} style={{ fontFamily: ICON }}>{copied ? "" : ""}</span>
					</button>
					<button
						type="button"
						onClick={saveImage}
						disabled={!currentUrl || isError || isRemoved}
						title={downloadLabel}
						aria-label={downloadLabel}
						data-testid="image-viewer-download"
						className={`${iconBtn} disabled:opacity-40 disabled:cursor-default`}
					>
						<span className="text-base leading-none" style={{ fontFamily: ICON }}>{""}</span>
					</button>
					<button
						type="button"
						onClick={() => (isRemote() ? openFileInBrowser(current.storedPath) : api.request.openImageFile({ path: current.storedPath }))
							.catch((err) => toast.error(t(err instanceof PopupBlockedError ? "imageViewer.popupBlocked" : "imageViewer.openFailed"), { taskId }))}
						disabled={isRemoved}
						title={isRemote() ? t("imageViewer.openInTab") : t("imageViewer.open")}
						aria-label={isRemote() ? t("imageViewer.openInTab") : t("imageViewer.open")}
						data-testid="image-viewer-open"
						className={`${iconBtn} disabled:opacity-40 disabled:cursor-default`}
					>
						<span className="text-base leading-none" style={{ fontFamily: ICON }}>{""}</span>
					</button>
					<button
						type="button"
						onClick={onClose}
						title={t("imageViewer.close")}
						aria-label={t("imageViewer.close")}
						data-testid="image-viewer-close"
						className={iconBtn}
					>
						<span className="text-lg leading-none" style={{ fontFamily: ICON }}>{""}</span>
					</button>
				</div>

				{/* Stage (+ the review aside in comment mode) */}
				<div className="flex flex-1 min-h-0">
				<div className="flex flex-1 min-w-0 min-h-0 flex-col bg-base">
				<div className="relative flex-1 min-h-0">
					{clip === "video" && stageStatus && (
						<div role="status" data-testid="video-stage-status" className="pointer-events-none absolute left-1/2 top-3 z-10 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-center text-xs text-white shadow-[0_1px_4px_rgb(0_0_0/0.4)]">
							{stageStatus}
						</div>
					)}
					<div
						ref={setStage}
						onContextMenu={openMenu}
						style={{ touchAction: isClip ? "manipulation" : fit === "width" ? "pan-y" : "none" }}
						className={`absolute inset-0 ${fit === "width" ? "overflow-y-auto overflow-x-hidden p-3" : "overflow-hidden p-4 flex items-center justify-center"}`}
					>
						{isRemoved ? (
							<div data-testid="viewer-media-removed" className="flex max-w-md flex-col items-center gap-2 text-center text-fg-3">
								<span className="text-3xl leading-none" style={{ fontFamily: ICON }}>{"\uf1f8"}</span>
								<span className="text-sm">{t("sharedMedia.removed")}</span>
								<span className="text-xs tabular-nums text-fg-muted">{formatBytes(current.bytes)} · {new Date(current.removedAt ?? 0).toLocaleDateString()}</span>
							</div>
						) : isError || (isClip && clipError) ? (
							<div data-testid="viewer-media-error" className="flex max-w-md flex-col items-center gap-2 text-center text-fg-3">
								<span className="text-3xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
								<span className="text-sm">{t(clipErrorKey(clip, isError))}</span>
							</div>
						) : clip === "video" && currentUrl ? (
							<video
								key={current.id}
								ref={attachVideo}
								src={currentUrl}
								playsInline
								onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play().catch(() => {}) : e.currentTarget.pause())}
								preload="metadata"
								onLoadedMetadata={(e) => primeFirstFrame(e.currentTarget)}
								aria-label={current.name}
								data-testid="viewer-main-video"
								onError={() => setClipError(true)}
								className="max-h-full max-w-full rounded-lg bg-black outline-none"
							/>
						) : clip === "audio" && currentUrl ? (
							<div className="flex w-full max-w-xl flex-col items-center gap-4 rounded-2xl bg-raised p-6 shadow-lg shadow-black/20">
								<span aria-hidden="true" className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/15 text-3xl text-accent" style={{ fontFamily: ICON }}>{AUDIO_GLYPH}</span>
								<span className="max-w-full truncate font-mono text-sm text-fg-2">{current.name}</span>
								<audio
									key={current.id}
									ref={(node) => { playerRef.current = node; }}
									src={currentUrl}
									controls
									preload="metadata"
									aria-label={current.name}
									data-testid="viewer-main-audio"
									onError={() => setClipError(true)}
									className="media-controls w-full outline-none"
								/>
							</div>
						) : currentUrl ? (
							<img
								ref={imgRef}
								src={currentUrl}
								alt={current.name}
								data-testid="viewer-main-image"
								onLoad={(e) => { setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 }); measurePicture(); }}
								style={fit === "fit" ? { transform: zoom.transform, transition: zoom.animated ? "transform 150ms ease-out" : "none" } : undefined}
								className={`select-none ${
									fit === "width"
										? "block mx-auto w-full max-w-[1400px] h-auto"
										: `w-full h-full object-contain will-change-transform ${zoom.zoomed ? "cursor-grab" : "cursor-zoom-in"}`
								}`}
								draggable={false}
							/>
						) : (
							<div className="flex h-full w-full items-center justify-center text-fg-3 text-sm">{t("imageViewer.loading")}</div>
						)}
						{showOverlay && (
							<ImageRegionOverlay
								box={pictureBox}
								picking={commentMode}
								comments={imageComments}
								activeCommentId={activeCommentId}
								onActivate={(id) => { setActiveCommentId(id); setCommentMode(true); }}
								pendingRegion={pendingRegion}
								onPick={setPendingRegion}
							/>
						)}
						{showSpots && videoBox && (
							<VideoFrameSpots
								box={videoBox}
								draft={showDraftSpots ? draftSpots : []}
								saved={savedSpots}
								placing={spotTool}
								selected={selectedSpot}
								onSelect={setSelectedSpot}
								onAdd={addSpot}
								onRemove={removeSpot}
							/>
						)}
					</div>

					{images.length > 1 && (
						<>
							<button
								type="button"
								onClick={() => go(-1)}
								disabled={index === 0}
								aria-label={t("imageViewer.prev")}
								className="absolute left-3 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 disabled:opacity-0 disabled:cursor-default transition-[background-color,opacity]"
							>
								<span className="text-xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
							</button>
							<button
								type="button"
								onClick={() => go(1)}
								disabled={index === images.length - 1}
								aria-label={t("imageViewer.next")}
								className="absolute right-3 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 disabled:opacity-0 disabled:cursor-default transition-[background-color,opacity]"
							>
								<span className="text-xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
							</button>
						</>
					)}
				</div>
				{clip === "video" && videoEl && currentUrl && !isError && !clipError && (
					<VideoReviewBar
						video={videoEl}
						fps={fps}
						markers={markers}
						activeMarkerId={activeCommentId}
						onMarker={(id) => { seekToComment(id); setCommentMode(true); }}
						onComment={canComment ? commentAtPlayhead : undefined}
						hold={frameHold}
						markerTool={canComment ? { active: spotTool, onToggle: toggleSpotTool } : undefined}
					/>
				)}
				</div>
				{canComment && commentMode && current && clip === "video" && (
					<ReviewAside
						testId="video-review"
						comments={videoComments}
						review={review}
						send={videoSend}
						sendAllHeldLabel={stillsInFlight.length > 0 ? t("imageViewer.savingFrame") : null}
						activeCommentId={activeCommentId}
						onActivate={seekToComment}
						labelFor={(comment, i) => `${i + 1} · ${formatReviewMoment(comment.anchor as ReviewVideoTimeAnchor)}`}
						pendingLabel={pendingMoment ? `${current.name} · ${formatReviewMoment(pendingMoment)}${draftSpots.length ? ` · ${t.plural("imageViewer.spotCount", draftSpots.length)}` : ""}` : null}
						onSubmitPick={(body, andSend) => { void addMomentComment(body, andSend); }}
						onCancelPick={() => { setPendingMoment(null); clearSpots(); }}
						hint={t("imageViewer.videoCommentModeHint")}
						empty={t("imageViewer.videoReviewEmpty")}
					/>
				)}
				{canComment && commentMode && current && !isClip && (
					<ReviewAside
						testId="image-review"
						comments={imageComments}
						review={review}
						send={send}
						activeCommentId={activeCommentId}
						onActivate={setActiveCommentId}
						labelFor={(comment, i) => `${i + 1} · ${regionLabel(comment.anchor as ReviewImageRegionAnchor)}`}
						pendingLabel={pendingRegion ? `${current.name} · ${regionLabel(pendingRegion)}` : null}
						onSubmitPick={addRegionComment}
						onCancelPick={() => setPendingRegion(null)}
						hint={t("imageViewer.commentModeHint")}
						empty={t("imageViewer.reviewEmpty")}
					/>
				)}
				</div>

				{/* Agent's note about the active image (what to look at here) */}
				{current.caption && (
					<div
						data-testid="viewer-caption"
						className="flex-shrink-0 flex items-start gap-2 px-4 py-2.5 text-sm leading-relaxed text-fg-2 border-t border-edge bg-raised max-h-28 overflow-y-auto whitespace-pre-wrap break-words"
					>
						<span className="mt-0.5 flex-shrink-0 text-fg-muted" style={{ fontFamily: ICON }}>{""}</span>
						<span className="min-w-0">{current.caption}</span>
					</div>
				)}

				{/* Thumbnail history rail */}
				{images.length > 1 && (
					<div className="flex-shrink-0 flex items-center border-t border-edge bg-raised">
					<div
						ref={thumbStripRef}
						data-wheel-x
						className="min-w-0 flex-1 flex justify-center gap-2 overflow-x-auto px-4 py-3"
					>
						{media.map((img, i) => {
							const thumbUrl = urls[img.id];
							const isNew = newSet.has(img.id);
							const thumbClip = isSharedClip(img) ? (isSharedAudio(img) ? "audio" : "video") : null;
							return (
								<button
									key={img.id}
									type="button"
									data-thumb-index={i}
									data-thumb-new={isNew ? "true" : undefined}
									onClick={() => setIndex(i)}
									aria-label={isNew ? `${img.name} — ${t("imageViewer.newImage")}` : img.name}
									aria-current={i === index}
									className={`flex-shrink-0 h-16 w-16 rounded-lg overflow-hidden border-2 transition-colors ${
										i === index ? "border-accent" : isNew ? "border-success" : "border-edge/50 hover:border-edge-active"
									} ${isNew ? "ring-2 ring-success/60 ring-offset-1 ring-offset-raised" : ""}`}
								>
									{img.removedAt ? (
										<span data-testid="viewer-thumb-removed" title={t("sharedMedia.removedBadge")} className="flex h-full w-full items-center justify-center bg-elevated text-fg-muted text-sm" style={{ fontFamily: ICON }}>{"\uf1f8"}</span>
									) : thumbClip === "video" ? (
										<VideoFrameThumb
											path={img.storedPath}
											fallback={<ClipThumbGlyph clip="video" title={t("imageViewer.video")} />}
											badge={<ClipPlayBadge testId="viewer-thumb-video" title={t("imageViewer.video")} />}
										/>
									) : thumbClip ? (
										<ClipThumbGlyph clip="audio" title={t("imageViewer.audio")} />
									) : thumbUrl && thumbUrl !== "__error__" ? (
										<img src={thumbUrl} alt={img.name} className="h-full w-full object-cover" draggable={false} />
									) : (
										<span className="flex h-full w-full items-center justify-center bg-elevated text-fg-muted text-xs" style={{ fontFamily: ICON }}>{"\u{F02E9}"}</span>
									)}
								</button>
							);
						})}
					</div>
					{cleanup.available && (
						<Tooltip content={cleanup.label} detail={t("sharedMedia.deleteOlderHint")}>
							<button
								type="button"
								data-testid="image-viewer-delete-older"
								onClick={() => void deleteOlder()}
								className="mr-4 flex-shrink-0 rounded-md border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 active:scale-[0.96]"
							>
								{cleanup.label}
							</button>
						</Tooltip>
					)}
					</div>
				)}

				{menu && (
					<ImageSaveMenu
						at={menu}
						onDownload={saveImage}
						onCopyPath={() => { setMenu(null); void copyPath(); }}
						onClose={() => setMenu(null)}
						onDelete={canDelete ? () => void deleteCurrent() : undefined}
						onTogglePin={canPin ? () => void togglePin() : undefined}
						pinned={Boolean(current.pinnedAt)}
						onDeleteOlder={cleanup.available ? { label: cleanup.label, run: () => void deleteOlder() } : undefined}
						media={clip ?? "image"}
					/>
				)}
			</div>
		</div>
	);
}
