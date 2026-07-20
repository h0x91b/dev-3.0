import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedImage } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { usePinchZoom } from "../hooks/usePinchZoom";

interface TaskImageViewerProps {
	images: SharedImage[];
	initialIndex: number;
	onClose: () => void;
	taskId?: string;
}

const ICON = "'JetBrainsMono Nerd Font Mono'";
// Above this height/width ratio an image is "tall" (e.g. a full-page capture) —
// object-contain would squash it into a useless sliver, so we default such
// images to fill-width + vertical scroll instead.
const TALL_RATIO = 2.2;

/**
 * Windowed lightbox for images an agent surfaced via `dev3 show-image`. It is a
 * centred modal card that fills ~90% of the viewport (≈5% margin each side) —
 * deliberately NOT a full-bleed takeover — so it reads as part of the current
 * task; a fullscreen toggle expands it edge-to-edge for detailed viewing. Shows
 * one large image with a thumbnail
 * history rail (newest activated first via initialIndex). Bytes are fetched
 * lazily through the existing `readImageBase64` RPC, so it works identically in
 * the desktop shell and the remote browser. Pure React overlay — no native
 * dialog (project rule).
 *
 * While open it marks <html data-image-viewer="open">, which hides the ghostty
 * WebGL terminal canvas behind it (index.css). In WKWebView a WebGL canvas is
 * promoted to a hardware overlay plane that paints ABOVE any DOM scrim, so
 * without this the live terminal would shine through around the card.
 */
export default function TaskImageViewer({ images, initialIndex, onClose, taskId }: TaskImageViewerProps) {
	const t = useT();
	const [index, setIndex] = useState(() => Math.max(0, Math.min(images.length - 1, initialIndex)));
	// Cache of image id → data URL ("__error__" marks a failed load).
	const [urls, setUrls] = useState<Record<string, string>>({});
	const [copied, setCopied] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	// Natural size of the active image (from onLoad) → drives the tall-image default.
	const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
	// null = auto (decide from aspect ratio); otherwise a manual override.
	const [fitOverride, setFitOverride] = useState<"fit" | "width" | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const thumbStripRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	// Ids whose fetch has already been kicked off — dedupes the priority effect
	// against the background loader so each image is read at most once.
	const startedRef = useRef<Set<string>>(new Set());
	const mountedRef = useRef(true);
	useEffect(() => () => { mountedRef.current = false; }, []);

	// Keep the active index valid when the image list changes (new arrivals).
	useEffect(() => {
		setIndex((i) => Math.max(0, Math.min(images.length - 1, i)));
	}, [images.length]);

	const current = images[index];
	// Aspect-driven display mode: tall captures scroll vertically ("width"),
	// everything else is centred + contained ("fit") and gets pinch-to-zoom.
	const isTall = natural ? natural.h / natural.w >= TALL_RATIO : false;
	const fit: "fit" | "width" = fitOverride ?? (isTall ? "width" : "fit");
	const zoom = usePinchZoom(fit === "fit");
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
			const res = await api.request.readImageBase64({ path: img.storedPath });
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
			if (j >= 0 && j < images.length) void loadImage(images[j]);
		}
	}, [index, images, loadImage]);

	// Background: eagerly load EVERY image (concurrency-capped) so the thumbnail
	// rail always shows a real picture — never a lazy placeholder that only fills
	// in as you scrub. The dedupe set skips anything the priority effect grabbed.
	useEffect(() => {
		let cancelled = false;
		const pending = images.filter((im) => !startedRef.current.has(im.id));
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

	// Keyboard navigation + Esc close + f = fullscreen.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") { e.preventDefault(); if (fullscreen) setFullscreen(false); else onClose(); }
			else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
			else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
			else if (e.key === "Home") { e.preventDefault(); setIndex(0); }
			else if (e.key === "End") { e.preventDefault(); setIndex(images.length - 1); }
			else if (e.key === "f" || e.key === "F") { e.preventDefault(); setFullscreen((v) => !v); }
		}
		window.addEventListener("keydown", onKey);
		containerRef.current?.focus();
		return () => window.removeEventListener("keydown", onKey);
	}, [go, onClose, images.length, fullscreen]);

	// Reset per-image derived state and scroll the active thumbnail into view.
	useEffect(() => {
		const strip = thumbStripRef.current;
		const active = strip?.querySelector<HTMLElement>(`[data-thumb-index="${index}"]`);
		active?.scrollIntoView({ inline: "center", block: "nearest" });
		setCopied(false);
		setNatural(null);
		setFitOverride(null);
		zoom.reset();
		if (stageRef.current) stageRef.current.scrollTop = 0;
	}, [index, zoom.reset]);

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

	const iconBtn = "flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 hover:bg-elevated-hover hover:text-fg transition-colors";

	return (
		<div
			className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/60 outline-none ${fullscreen ? "p-0" : "px-[5vw] py-[5vh]"}`}
			onClick={onClose}
		>
			<div
				ref={containerRef}
				role="dialog"
				aria-modal="true"
				aria-label={t("imageViewer.title")}
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
					<span className="flex-shrink-0 font-mono text-xs text-fg-3 tabular-nums">
						{index + 1} / {images.length}
					</span>
					{isTall && (
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
						title={t("imageViewer.copyPath")}
						aria-label={t("imageViewer.copyPath")}
						className={iconBtn}
					>
						<span className={`text-base leading-none ${copied ? "text-success" : ""}`} style={{ fontFamily: ICON }}>{copied ? "" : ""}</span>
					</button>
					<button
						type="button"
						onClick={() => api.request.openImageFile({ path: current.storedPath }).catch(() => toast.error(t("imageViewer.openFailed"), { taskId }))}
						title={t("imageViewer.open")}
						aria-label={t("imageViewer.open")}
						className={iconBtn}
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

				{/* Stage */}
				<div className="relative flex-1 min-h-0 bg-base">
					<div
						ref={setStage}
						style={{ touchAction: fit === "width" ? "pan-y" : "none" }}
						className={`absolute inset-0 ${fit === "width" ? "overflow-y-auto overflow-x-hidden p-3" : "overflow-hidden p-4 flex items-center justify-center"}`}
					>
						{isError ? (
							<div className="flex flex-col items-center gap-2 text-fg-3">
								<span className="text-3xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
								<span className="text-sm">{t("imageViewer.loadError")}</span>
							</div>
						) : currentUrl ? (
							<img
								src={currentUrl}
								alt={current.name}
								data-testid="viewer-main-image"
								onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
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
					</div>

					{images.length > 1 && (
						<>
							<button
								type="button"
								onClick={() => go(-1)}
								disabled={index === 0}
								aria-label={t("imageViewer.prev")}
								className="absolute left-3 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 disabled:opacity-0 disabled:cursor-default transition-all"
							>
								<span className="text-xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
							</button>
							<button
								type="button"
								onClick={() => go(1)}
								disabled={index === images.length - 1}
								aria-label={t("imageViewer.next")}
								className="absolute right-3 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 disabled:opacity-0 disabled:cursor-default transition-all"
							>
								<span className="text-xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
							</button>
						</>
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
					<div
						ref={thumbStripRef}
						className="flex-shrink-0 flex justify-center gap-2 overflow-x-auto px-4 py-3 border-t border-edge bg-raised"
					>
						{images.map((img, i) => {
							const thumbUrl = urls[img.id];
							return (
								<button
									key={img.id}
									type="button"
									data-thumb-index={i}
									onClick={() => setIndex(i)}
									aria-label={img.name}
									aria-current={i === index}
									className={`flex-shrink-0 h-16 w-16 rounded-lg overflow-hidden border-2 transition-colors ${
										i === index ? "border-accent" : "border-edge/50 hover:border-edge-active"
									}`}
								>
									{thumbUrl && thumbUrl !== "__error__" ? (
										<img src={thumbUrl} alt={img.name} className="h-full w-full object-cover" draggable={false} />
									) : (
										<span className="flex h-full w-full items-center justify-center bg-elevated text-fg-muted text-xs" style={{ fontFamily: ICON }}>{"\u{F02E9}"}</span>
									)}
								</button>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
