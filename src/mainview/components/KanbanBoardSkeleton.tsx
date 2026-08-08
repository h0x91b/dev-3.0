import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

/** Placeholder card counts per column — uneven so the board reads as content. */
const COLUMN_CARDS = [3, 2, 4, 2, 3];

/** Enough cards to fill a phone screen; the column clips the overflow. */
const PHONE_CARDS = 12;

/** Local fetches resolve in a few ms; don't flash a skeleton at them. */
const DEFAULT_APPEAR_AFTER_MS = 200;

/**
 * Board placeholder shown while the first `getTasks` is in flight and no cached
 * tasks exist. Without it the real board renders every column's "no tasks yet"
 * empty state, which on a slow or dropped remote link is an outright lie — the
 * board looks empty instead of loading.
 */
export default function KanbanBoardSkeleton({
	appearAfterMs = DEFAULT_APPEAR_AFTER_MS,
}: {
	appearAfterMs?: number;
}) {
	const t = useT();
	const isCarousel = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [visible, setVisible] = useState(appearAfterMs === 0);

	useEffect(() => {
		if (appearAfterMs === 0) return;
		const id = setTimeout(() => setVisible(true), appearAfterMs);
		return () => clearTimeout(id);
	}, [appearAfterMs]);

	if (!visible) return <div className="flex-1 min-h-0" />;

	// Phones get the carousel shell — one full-width column under a pager row.
	// Five columns squeezed into a phone read as empty vertical rails, not as a
	// board that is loading.
	if (isCarousel) {
		return (
			<div
				className="flex-1 min-h-0 flex flex-col"
				role="status"
				aria-label={t("kanban.loadingTasks")}
				data-testid="kanban-skeleton"
			>
				<div className="flex items-center gap-2 px-2 py-2 border-b border-edge flex-shrink-0 animate-pulse">
					<div className="w-9 h-9 rounded-lg bg-elevated" />
					<div className="flex-1 flex justify-center">
						<div className="h-3 w-12 rounded-full bg-elevated" />
					</div>
					<div className="w-9 h-9 rounded-lg bg-elevated" />
				</div>
				<div className="flex-1 min-h-0 flex px-3 pb-3 pt-2">
					<div
						className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden rounded-2xl border border-edge bg-raised/40 p-3 animate-pulse"
						data-testid="kanban-skeleton-column"
					>
						<div className="h-3 w-24 flex-shrink-0 rounded-full bg-elevated" />
						{Array.from({ length: PHONE_CARDS }, (_, cardIndex) => (
							<div key={cardIndex} className="h-20 flex-shrink-0 rounded-xl bg-elevated" />
						))}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className="flex-1 min-h-0 flex gap-5 px-6 pb-6 pt-2 overflow-hidden"
			role="status"
			aria-label={t("kanban.loadingTasks")}
			data-testid="kanban-skeleton"
		>
			{COLUMN_CARDS.map((cards, columnIndex) => (
				<div
					key={columnIndex}
					className="flex-1 min-w-0 flex flex-col gap-3 rounded-2xl border border-edge bg-raised/40 p-3 animate-pulse"
					data-testid="kanban-skeleton-column"
				>
					<div className="h-3 w-24 rounded-full bg-elevated" />
					{Array.from({ length: cards }, (_, cardIndex) => (
						<div key={cardIndex} className="h-20 rounded-xl bg-elevated" />
					))}
				</div>
			))}
		</div>
	);
}
