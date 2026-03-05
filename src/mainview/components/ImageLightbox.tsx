import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { api } from "../rpc";
import { useT } from "../i18n";

const dataUrlCache = new Map<string, string>();

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

	const path = paths[index];

	useEffect(() => {
		setIndex(currentIndex);
	}, [currentIndex]);

	useEffect(() => {
		if (dataUrlCache.has(path)) {
			setDataUrl(dataUrlCache.get(path)!);
			setLoading(false);
			return;
		}

		let cancelled = false;
		setLoading(true);

		api.request.readImageBase64({ path }).then((result) => {
			if (cancelled) return;
			if (result) {
				dataUrlCache.set(path, result.dataUrl);
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

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
			if (e.key === "ArrowRight") goNext();
			if (e.key === "ArrowLeft") goPrev();
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [onClose, goNext, goPrev]);

	function handleOpenExternal() {
		api.request.openImageFile({ path }).catch(() => {});
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
						alt={path.split("/").pop() ?? ""}
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

					{/* Open in Preview */}
					<button
						onClick={handleOpenExternal}
						className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors"
					>
						{t("images.openInPreview")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
