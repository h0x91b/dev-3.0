import { useMemo } from "react";
import type { HeatmapDay } from "../../utils/productivityStats";

interface ContributionHeatmapProps {
	days: HeatmapDay[];
	maxCount: number;
	/** Localized "Less" / "More" legend captions. */
	legendLess: string;
	legendMore: string;
	/** Builds the native-title tooltip for a cell. */
	tooltipFor: (count: number, ms: number) => string;
}

const CELL = 11;
const GAP = 3;

/** Intensity bucket 0–4 for a day's count relative to the busiest day. */
function bucket(count: number, max: number): number {
	if (count <= 0 || max <= 0) return 0;
	const r = count / max;
	if (r <= 0.25) return 1;
	if (r <= 0.5) return 2;
	if (r <= 0.75) return 3;
	return 4;
}

// Accent scale by opacity (level 0 = empty surface). Tokens stay theme-aware.
const LEVEL_CLASS = ["bg-elevated", "bg-accent/25", "bg-accent/45", "bg-accent/70", "bg-accent"];

/**
 * GitHub-style contribution heatmap of tasks shipped per day over the trailing
 * year. Range-independent. Week columns (7 day-rows each), accent-shaded by
 * intensity, with aligned month labels and a native-title tooltip per cell.
 */
export function ContributionHeatmap({ days, maxCount, legendLess, legendMore, tooltipFor }: ContributionHeatmapProps) {
	const weeks = useMemo(() => {
		const out: HeatmapDay[][] = [];
		for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
		return out;
	}, [days]);

	// Month label per week column: shown only when the month changes vs the prior week.
	const monthLabels = useMemo(() => {
		let prev = -1;
		return weeks.map((week) => {
			const first = week[0];
			if (!first) return "";
			const m = new Date(first.ms).getMonth();
			if (m !== prev) {
				prev = m;
				return new Date(first.ms).toLocaleDateString(undefined, { month: "short" });
			}
			return "";
		});
	}, [weeks]);

	return (
		<div className="overflow-x-auto">
			<div className="inline-flex flex-col gap-1">
				{/* Month labels, column-aligned with the grid below. */}
				<div
					className="grid text-fg-muted text-[0.5625rem] leading-none"
					style={{ gridAutoFlow: "column", gridAutoColumns: `${CELL}px`, columnGap: `${GAP}px` }}
				>
					{monthLabels.map((label, i) => (
						<div key={i} className="overflow-visible whitespace-nowrap">{label}</div>
					))}
				</div>

				{/* Day cells: 7 rows, one column per week, filled column-major. */}
				<div
					className="grid"
					style={{
						gridTemplateRows: `repeat(7, ${CELL}px)`,
						gridAutoFlow: "column",
						gridAutoColumns: `${CELL}px`,
						gap: `${GAP}px`,
					}}
				>
					{days.map((d) => (
						<div
							key={d.ms}
							className={`rounded-[2px] ${LEVEL_CLASS[bucket(d.count, maxCount)]}`}
							title={tooltipFor(d.count, d.ms)}
						/>
					))}
				</div>

				{/* Legend */}
				<div className="flex items-center gap-1 mt-0.5 text-fg-muted text-[0.5625rem]">
					<span className="mr-0.5">{legendLess}</span>
					{LEVEL_CLASS.map((cls, i) => (
						<div key={i} className={`rounded-[2px] ${cls}`} style={{ width: CELL, height: CELL }} />
					))}
					<span className="ml-0.5">{legendMore}</span>
				</div>
			</div>
		</div>
	);
}

export default ContributionHeatmap;
