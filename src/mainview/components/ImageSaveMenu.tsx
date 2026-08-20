import { useEffect, useLayoutEffect, useRef } from "react";
import { useT } from "../i18n";

const ICON = "'JetBrainsMono Nerd Font Mono'";

interface ImageSaveMenuProps {
	/** Viewport coordinates of the right-click that opened it. */
	at: { x: number; y: number };
	onDownload: () => void;
	onCopyPath?: () => void;
	onClose: () => void;
}

/**
 * Right-click menu for a previewed image. WKWebView's native "Save Image As…" does
 * nothing useful in this shell (same reason the artifact viewer injects its own menu
 * — decision 2026/07/21 artifact-image-save-via-parent), so every image preview
 * brings its own. Escape belongs to the host overlay, which knows it must close the
 * menu before itself.
 */
export default function ImageSaveMenu({ at, onDownload, onCopyPath, onClose }: ImageSaveMenuProps) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);

	// Keep the menu inside the viewport — a right-click near the edge would
	// otherwise open it half off-screen.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8))}px`;
		el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8))}px`;
	}, [at]);

	// A menu pinned to stale coordinates is worse than no menu.
	useEffect(() => {
		const close = (e?: Event) => {
			if (e?.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
			onClose();
		};
		window.addEventListener("pointerdown", close, true);
		window.addEventListener("resize", close);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("pointerdown", close, true);
			window.removeEventListener("resize", close);
			window.removeEventListener("blur", close);
		};
	}, [onClose]);

	const item = "w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors";
	const glyph = "w-4 text-center text-sm leading-none flex-shrink-0";

	return (
		<div
			ref={ref}
			role="menu"
			data-testid="image-save-menu"
			className="fixed z-[10000] min-w-[11.25rem] rounded-xl border border-edge-active bg-overlay py-1.5 shadow-2xl shadow-black/40"
			style={{ left: at.x, top: at.y }}
		>
			<button type="button" role="menuitem" data-testid="image-save-menu-download" onClick={onDownload} className={item}>
				<span className={glyph} style={{ fontFamily: ICON }}>{""}</span>
				{t("imageViewer.download")}
			</button>
			{onCopyPath && (
				<button type="button" role="menuitem" data-testid="image-save-menu-copy-path" onClick={onCopyPath} className={item}>
					<span className={glyph} style={{ fontFamily: ICON }}>{""}</span>
					{t("imageViewer.copyPath")}
				</button>
			)}
		</div>
	);
}
