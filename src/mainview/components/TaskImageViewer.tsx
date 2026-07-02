import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedImage } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";

interface TaskImageViewerProps {
	images: SharedImage[];
	initialIndex: number;
	onClose: () => void;
}

const ICON = "'JetBrainsMono Nerd Font Mono'";

/**
 * Full-bleed lightbox for images an agent surfaced via `dev3 show-image`. Shows
 * one large image with a thumbnail history rail (newest activated first via
 * initialIndex). Bytes are fetched lazily through the existing `readImageBase64`
 * RPC, so it works identically in the desktop shell and the remote browser.
 * Pure React overlay — no native dialog (project rule).
 */
export default function TaskImageViewer({ images, initialIndex, onClose }: TaskImageViewerProps) {
	const t = useT();
	const [index, setIndex] = useState(() => Math.max(0, Math.min(images.length - 1, initialIndex)));
	// Cache of image id → data URL ("__error__" marks a failed load).
	const [urls, setUrls] = useState<Record<string, string>>({});
	const [copied, setCopied] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const thumbStripRef = useRef<HTMLDivElement>(null);

	// Keep the active index valid when the image list changes (new arrivals).
	useEffect(() => {
		setIndex((i) => Math.max(0, Math.min(images.length - 1, i)));
	}, [images.length]);

	const current = images[index];

	// Lazily fetch the active image (and its immediate neighbours) as data URLs.
	useEffect(() => {
		const wanted = [index - 1, index, index + 1]
			.filter((i) => i >= 0 && i < images.length)
			.map((i) => images[i]);
		let cancelled = false;
		for (const img of wanted) {
			if (urls[img.id]) continue;
			api.request
				.readImageBase64({ path: img.storedPath })
				.then((res) => {
					if (cancelled) return;
					setUrls((prev) => ({ ...prev, [img.id]: res?.dataUrl ?? "__error__" }));
				})
				.catch(() => {
					if (!cancelled) setUrls((prev) => ({ ...prev, [img.id]: "__error__" }));
				});
		}
		return () => {
			cancelled = true;
		};
	}, [index, images, urls]);

	const go = useCallback((delta: number) => {
		setIndex((i) => Math.max(0, Math.min(images.length - 1, i + delta)));
	}, [images.length]);

	// Keyboard navigation + Esc close.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") { e.preventDefault(); onClose(); }
			else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
			else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
			else if (e.key === "Home") { e.preventDefault(); setIndex(0); }
			else if (e.key === "End") { e.preventDefault(); setIndex(images.length - 1); }
		}
		window.addEventListener("keydown", onKey);
		containerRef.current?.focus();
		return () => window.removeEventListener("keydown", onKey);
	}, [go, onClose, images.length]);

	// Keep the active thumbnail scrolled into view; reset the copied flag on move.
	useEffect(() => {
		const strip = thumbStripRef.current;
		const active = strip?.querySelector<HTMLElement>(`[data-thumb-index="${index}"]`);
		active?.scrollIntoView({ inline: "center", block: "nearest" });
		setCopied(false);
	}, [index]);

	if (!current) return null;

	const currentUrl = urls[current.id];
	const isError = currentUrl === "__error__";

	const copyPath = async () => {
		try {
			await navigator.clipboard.writeText(current.storedPath);
			setCopied(true);
		} catch {
			toast.error(t("imageViewer.copyFailed"));
		}
	};

	return (
		<div
			ref={containerRef}
			role="dialog"
			aria-modal="true"
			aria-label={t("imageViewer.title")}
			tabIndex={-1}
			className="fixed inset-0 z-[70] flex flex-col bg-black/85 outline-none"
			onClick={onClose}
		>
			{/* Top bar: name / caption / counter / actions */}
			<div
				className="flex items-center gap-3 px-4 py-2.5 text-sm text-fg-2 border-b border-edge/60"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="min-w-0 flex-1">
					<div className="truncate text-fg font-medium" title={current.originalPath}>{current.name}</div>
					{current.caption && <div className="truncate text-xs text-fg-3">{current.caption}</div>}
				</div>
				<span className="flex-shrink-0 font-mono text-xs text-fg-3 tabular-nums">
					{index + 1} / {images.length}
				</span>
				<button
					type="button"
					onClick={copyPath}
					title={t("imageViewer.copyPath")}
					aria-label={t("imageViewer.copyPath")}
					className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 hover:bg-elevated hover:text-fg transition-colors"
				>
					<span className={`text-base leading-none ${copied ? "text-success" : ""}`} style={{ fontFamily: ICON }}>{copied ? "" : ""}</span>
				</button>
				<button
					type="button"
					onClick={() => api.request.openImageFile({ path: current.storedPath }).catch(() => toast.error(t("imageViewer.openFailed")))}
					title={t("imageViewer.open")}
					aria-label={t("imageViewer.open")}
					className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 hover:bg-elevated hover:text-fg transition-colors"
				>
					<span className="text-base leading-none" style={{ fontFamily: ICON }}>{""}</span>
				</button>
				<button
					type="button"
					onClick={onClose}
					title={t("imageViewer.close")}
					aria-label={t("imageViewer.close")}
					data-testid="image-viewer-close"
					className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 hover:bg-elevated hover:text-fg transition-colors"
				>
					<span className="text-lg leading-none" style={{ fontFamily: ICON }}>{""}</span>
				</button>
			</div>

			{/* Stage */}
			<div className="relative flex-1 min-h-0 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
				{images.length > 1 && (
					<button
						type="button"
						onClick={() => go(-1)}
						disabled={index === 0}
						aria-label={t("imageViewer.prev")}
						className="absolute left-3 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-raised/80 text-fg hover:bg-elevated disabled:opacity-30 disabled:cursor-default transition-colors"
					>
						<span className="text-xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
					</button>
				)}
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
						className="max-h-full max-w-full object-contain select-none"
						draggable={false}
					/>
				) : (
					<div className="text-fg-3 text-sm">{t("imageViewer.loading")}</div>
				)}
				{images.length > 1 && (
					<button
						type="button"
						onClick={() => go(1)}
						disabled={index === images.length - 1}
						aria-label={t("imageViewer.next")}
						className="absolute right-3 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-raised/80 text-fg hover:bg-elevated disabled:opacity-30 disabled:cursor-default transition-colors"
					>
						<span className="text-xl leading-none" style={{ fontFamily: ICON }}>{""}</span>
					</button>
				)}
			</div>

			{/* Thumbnail history rail */}
			{images.length > 1 && (
				<div
					ref={thumbStripRef}
					className="flex-shrink-0 flex gap-2 overflow-x-auto px-4 py-3 border-t border-edge/60"
					onClick={(e) => e.stopPropagation()}
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
								className={`flex-shrink-0 h-14 w-14 rounded-lg overflow-hidden border-2 transition-colors ${
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
	);
}
