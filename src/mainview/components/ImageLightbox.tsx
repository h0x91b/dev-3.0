import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useT } from "../i18n";
import { toast } from "../toast";
import { downloadDataUrl } from "../utils/downloadBytes";
import ImageSaveMenu from "./ImageSaveMenu";

export const DATA_URL_CACHE_MAX = 30;
export const dataUrlCache = new Map<string, string>();

/** Move key to end (most-recently-used) and evict oldest if over limit. */
export function cacheSet(key: string, value: string): void {
	// Re-insert to move to end of iteration order
	dataUrlCache.delete(key);
	dataUrlCache.set(key, value);
	// Evict oldest entries (first in iteration order)
	while (dataUrlCache.size > DATA_URL_CACHE_MAX) {
		const oldest = dataUrlCache.keys().next().value;
		if (oldest !== undefined) dataUrlCache.delete(oldest);
		else break;
	}
}

/** Touch key to mark as recently used. */
export function cacheGet(key: string): string | undefined {
	const value = dataUrlCache.get(key);
	if (value !== undefined) {
		// Re-insert to move to end
		dataUrlCache.delete(key);
		dataUrlCache.set(key, value);
	}
	return value;
}

interface ImageLightboxProps {
	paths: string[];
	currentIndex: number;
	onClose: () => void;
}

export function ImageLightbox({ paths, currentIndex, onClose }: ImageLightboxProps) {
	const t = useT();
	const [index, setIndex] = useState(currentIndex);
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// Our own right-click menu — WKWebView's native "Save Image As…" is dead here.
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

	const path = paths[index];
	const fileName = path?.split("/").pop() ?? "image";

	useEffect(() => {
		setIndex(currentIndex);
	}, [currentIndex]);

	useEffect(() => {
		const cached = cacheGet(path);
		if (cached !== undefined) {
			setDataUrl(cached);
			setLoading(false);
			return;
		}

		let cancelled = false;
		setLoading(true);

		api.request.readImageBase64({ path }).then((result) => {
			if (cancelled) return;
			if (result) {
				cacheSet(path, result.dataUrl);
				setDataUrl(result.dataUrl);
			}
			setLoading(false);
		}).catch(() => {
			if (!cancelled) setLoading(false);
		});

		return () => { cancelled = true; };
	}, [path]);

	const goNext = useCallback(() => {
		if (index < paths.length - 1) setIndex(index + 1);
	}, [index, paths.length]);

	const goPrev = useCallback(() => {
		if (index > 0) setIndex(index - 1);
	}, [index]);

	// Escape closes the menu first when it is open, then the lightbox.
	useEscapeKey(() => { if (menu) setMenu(null); else onClose(); });
	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "ArrowRight") goNext();
			if (e.key === "ArrowLeft") goPrev();
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [goNext, goPrev]);

	function handleOpenExternal() {
		api.request.openImageFile({ path }).catch(() => {});
	}

	function handleDownload() {
		setMenu(null);
		if (!dataUrl) return;
		try {
			downloadDataUrl(dataUrl, fileName);
			toast.success(t("imageViewer.saved"));
		} catch {
			toast.error(t("imageViewer.saveFailed"));
		}
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
			onClick={onClose}
		>
			<div
				className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Close button */}
				<button
					onClick={onClose}
					className="absolute -top-2 -right-2 z-10 w-8 h-8 rounded-full bg-overlay border border-edge flex items-center justify-center text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					title={t("images.close")}
				>
					<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>

				{/* Image */}
				{loading ? (
					<div className="w-[18.75rem] h-[12.5rem] rounded-xl bg-elevated animate-pulse flex items-center justify-center">
						<span className="text-sm text-fg-muted">{t("images.loading")}</span>
					</div>
				) : dataUrl ? (
					<img
						src={dataUrl}
						alt={fileName}
						onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
						className="max-w-[90vw] max-h-[80vh] rounded-xl object-contain"
					/>
				) : (
					<div className="w-[18.75rem] h-[12.5rem] rounded-xl bg-elevated flex items-center justify-center">
						<span className="text-sm text-danger">{t("images.loadFailed")}</span>
					</div>
				)}

				{/* Bottom controls */}
				<div className="flex items-center gap-3">
					{/* Nav arrows */}
					{paths.length > 1 && (
						<>
							<button
								onClick={goPrev}
								disabled={index === 0}
								className="px-2 py-1 rounded-lg bg-overlay border border-edge text-fg-2 hover:text-fg disabled:opacity-30 transition-colors"
							>
								<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
								</svg>
							</button>
							<span className="text-xs text-fg-muted">{index + 1} / {paths.length}</span>
							<button
								onClick={goNext}
								disabled={index === paths.length - 1}
								className="px-2 py-1 rounded-lg bg-overlay border border-edge text-fg-2 hover:text-fg disabled:opacity-30 transition-colors"
							>
								<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
								</svg>
							</button>
						</>
					)}

					{/* Download */}
					<button
						onClick={handleDownload}
						disabled={!dataUrl}
						title={t("imageViewer.download")}
						aria-label={t("imageViewer.download")}
						data-testid="lightbox-download"
						className="px-2 py-1 rounded-lg bg-overlay border border-edge text-fg-2 hover:text-fg disabled:opacity-30 transition-colors"
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
						</svg>
					</button>

					{/* Open in Preview */}
					<button
						onClick={handleOpenExternal}
						className="px-3 py-1.5 rounded-lg bg-accent-fill text-white text-xs font-medium hover:bg-accent-fill-hover transition-colors"
					>
						{t("images.openInPreview")}
					</button>
				</div>

				{menu && (
					<ImageSaveMenu at={menu} onDownload={handleDownload} onClose={() => setMenu(null)} />
				)}
			</div>
		</div>,
		document.body,
	);
}
