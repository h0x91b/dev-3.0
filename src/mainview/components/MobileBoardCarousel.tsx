import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { useT } from "../i18n";

/**
 * Below this viewport width the Kanban board switches to a one-column carousel.
 * Gated via a media query (useNarrowViewport) so it reacts to window resize,
 * works in browser remote mode, and never affects the wide desktop layout.
 */
export const CAROUSEL_MAX_WIDTH = 768;

export interface CarouselColumn {
	id: string;
	label: string;
	color: string;
	count: number;
	element: ReactNode;
}

function initialColumnIndex(columns: CarouselColumn[], initialColumnId?: string): number {
	if (!initialColumnId) return 0;
	const index = columns.findIndex((column) => column.id === initialColumnId);
	return index >= 0 ? index : 0;
}

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Narrow-viewport board: shows exactly one column at a time. Horizontal swipe
 * (native CSS scroll-snap) or the pager chevrons/dots change the column;
 * the column body scrolls vertically. Each swipe has a button + keyboard
 * (Arrow Left/Right) equivalent and announces the active column via aria-live.
 */
function MobileBoardCarousel({ columns, initialColumnId }: { columns: CarouselColumn[]; initialColumnId?: string }) {
	const t = useT();
	const trackRef = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(() => initialColumnIndex(columns, initialColumnId));
	const hasUserNavigatedRef = useRef(false);
	const rafRef = useRef<number | null>(null);

	// Clamp the active index when the column set shrinks (e.g. a filter hides columns).
	useEffect(() => {
		setActive((i) => Math.max(0, Math.min(i, columns.length - 1)));
	}, [columns.length]);

	const goTo = useCallback(
		(index: number, userInitiated = true) => {
			if (userInitiated) hasUserNavigatedRef.current = true;
			const track = trackRef.current;
			if (!track) return;
			const clamped = Math.max(0, Math.min(index, columns.length - 1));
			track.scrollTo({ left: clamped * track.clientWidth, behavior: prefersReducedMotion() ? "auto" : "smooth" });
			setActive(clamped);
		},
		[columns.length],
	);

	// Tasks arrive after the board shell mounts. Until the user navigates, apply
	// the preferred attention column as soon as it becomes available.
	useEffect(() => {
		if (columns.length === 0 || !initialColumnId || hasUserNavigatedRef.current) return;
		const preferredIndex = columns.findIndex((column) => column.id === initialColumnId);
		if (preferredIndex >= 0) goTo(preferredIndex, false);
	}, [columns.length, goTo, initialColumnId]);

	// Keep the active index in sync with manual swipes.
	const handleScroll = useCallback(() => {
		if (rafRef.current != null) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			const track = trackRef.current;
			if (!track || track.clientWidth === 0) return;
			setActive(Math.max(0, Math.min(Math.round(track.scrollLeft / track.clientWidth), columns.length - 1)));
		});
	}, [columns.length]);

	useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			goTo(active - 1);
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			goTo(active + 1);
		}
	}

	if (columns.length === 0) return null;
	const current = columns[Math.max(0, Math.min(active, columns.length - 1))];

	return (
		<div
			className="flex-1 min-h-0 flex flex-col"
			role="group"
			aria-roledescription={t("kanban.carouselRole")}
			onKeyDown={handleKeyDown}
		>
			{/* Pager header */}
			<div className="flex items-center gap-2 px-2 py-2 border-b border-edge flex-shrink-0">
				<button
					type="button"
					onClick={() => goTo(active - 1)}
					disabled={active === 0}
					aria-label={t("kanban.carouselPrev")}
					title={t("kanban.carouselPrev")}
					className="w-9 h-9 flex items-center justify-center rounded-lg text-fg-muted hover:text-accent hover:bg-raised-hover disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted transition-colors flex-shrink-0"
				>
					{/* Nerd Font: fa-chevron-left (U+F053) */}
					<span className="font-mono text-sm leading-none">{""}</span>
				</button>
				<div className="flex-1 min-w-0 text-center" aria-live="polite">
					<div className="flex items-center justify-center gap-2 min-w-0">
						<span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: current.color }} />
						<span className="font-semibold text-fg truncate">{current.label}</span>
						<span className="text-[0.625rem] font-bold text-fg-muted bg-fg/10 px-1.5 py-px rounded-full flex-shrink-0">
							{current.count}
						</span>
					</div>
					<div className="text-[0.625rem] text-fg-muted mt-0.5">
						{active + 1} / {columns.length}
					</div>
				</div>
				<button
					type="button"
					onClick={() => goTo(active + 1)}
					disabled={active === columns.length - 1}
					aria-label={t("kanban.carouselNext")}
					title={t("kanban.carouselNext")}
					className="w-9 h-9 flex items-center justify-center rounded-lg text-fg-muted hover:text-accent hover:bg-raised-hover disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted transition-colors flex-shrink-0"
				>
					{/* Nerd Font: fa-chevron-right (U+F054) */}
					<span className="font-mono text-sm leading-none">{""}</span>
				</button>
			</div>

			{/* Dot indicators (also jump targets) */}
			{columns.length > 1 && (
				<div className="flex items-center justify-center gap-1.5 py-1.5 flex-shrink-0 flex-wrap px-3">
					{columns.map((col, i) => (
						<button
							key={col.id}
							type="button"
							onClick={() => goTo(i)}
							aria-label={t("kanban.carouselGoTo", { label: col.label })}
							aria-current={i === active}
							className={`h-1.5 rounded-full transition-all ${
								i === active ? "w-4 bg-accent" : "w-1.5 bg-edge hover:bg-edge-active"
							}`}
						/>
					))}
				</div>
			)}

			{/* Scroll-snap track: one column == 100% of the track width */}
			<div
				ref={trackRef}
				onScroll={handleScroll}
				onPointerDown={() => { hasUserNavigatedRef.current = true; }}
				className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory kanban-carousel-track"
			>
				{columns.map((col) => (
					<div key={col.id} className="w-full flex-shrink-0 snap-start h-full px-3 pb-3 overflow-hidden flex">
						{col.element}
					</div>
				))}
			</div>
		</div>
	);
}

export default MobileBoardCarousel;
