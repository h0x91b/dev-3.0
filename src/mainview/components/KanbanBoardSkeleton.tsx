import { useEffect, useState } from "react";
import { useT } from "../i18n";

/** Placeholder card counts per column — uneven so the board reads as content. */
const COLUMN_CARDS = [3, 2, 4, 2, 3];

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
	const [visible, setVisible] = useState(appearAfterMs === 0);

	useEffect(() => {
		if (appearAfterMs === 0) return;
		const id = setTimeout(() => setVisible(true), appearAfterMs);
		return () => clearTimeout(id);
	}, [appearAfterMs]);

	if (!visible) return <div className="flex-1 min-h-0" />;

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
