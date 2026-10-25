/** A row's vertical extent in its scroller's content coordinates. */
export interface RowSpan {
	top: number;
	height: number;
}

/**
 * Index the dragged row lands at: how many OTHER rows have their middle above
 * the preview's middle, never above `minIndex` (rows pinned at the top).
 */
export function reorderTargetIndex(rows: RowSpan[], origin: number, previewMid: number, minIndex = 0): number {
	let index = 0;
	rows.forEach((row, i) => {
		if (i !== origin && row.top + row.height / 2 < previewMid) index += 1;
	});
	return Math.max(index, minIndex);
}

/**
 * Per-row translateY that shows the list as if the dragged row already sat at
 * `target`: rows it passed slide into its old slot, and the dragged row's own
 * slot moves to where it will land. Layout never changes, so the spans measured
 * at drag start stay valid for the whole drag.
 */
export function reorderShifts(rows: RowSpan[], origin: number, target: number): number[] {
	const source = rows[origin];
	const next = rows[origin + 1] ?? rows[origin - 1];
	const gap = next ? Math.abs(next.top - source.top) - (next.top > source.top ? source.height : next.height) : 0;
	const step = source.height + gap;
	return rows.map((_row, i) => {
		if (i === origin) {
			if (target > origin) return rows[target].top + rows[target].height - (source.top + source.height);
			if (target < origin) return rows[target].top - source.top;
			return 0;
		}
		if (origin < i && i <= target) return -step;
		if (target <= i && i < origin) return step;
		return 0;
	});
}

/** The (target, side) pair the existing reorder callbacks take, or null for "stays put". */
export function reorderDropTarget(ids: string[], origin: number, target: number): { targetId: string; side: "before" | "after" } | null {
	if (target === origin || !ids[target]) return null;
	return { targetId: ids[target], side: target > origin ? "after" : "before" };
}
