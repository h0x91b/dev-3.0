import { Cell, Pie, PieChart as RPieChart, ResponsiveContainer, Tooltip } from "recharts";
import { PieTooltip } from "./ChartTooltip";
import { useChartColors } from "./useChartColors";

export interface PieBreakdownDatum {
	id: string;
	name: string;
	completed: number;
	lines: number;
	sharePct: number;
}

interface BreakdownPieProps {
	data: PieBreakdownDatum[];
	height?: number;
	/** Unit label for the donut center + tooltip (e.g. "tasks"). */
	tasksLabel: string;
	/** Label for the LOC line in the tooltip (e.g. "LOC"). */
	linesLabel: string;
	/** Centered total caption (e.g. "shipped"). */
	totalLabel: string;
	/** Accessible name for this read-only chart and legend group. */
	ariaLabel: string;
}

/** Shared donut breakdown used by the agent and model-configuration distributions. */
export function BreakdownPie({ data, height = 200, tasksLabel, linesLabel, totalLabel, ariaLabel }: BreakdownPieProps) {
	const c = useChartColors();
	const sliceColor = (i: number) => c.slices[i % c.slices.length];
	const pieData = data.map((item) => ({
		id: item.id,
		name: item.name,
		value: item.completed,
		lines: item.lines,
		sharePct: item.sharePct,
	}));
	const total = pieData.reduce((sum, item) => sum + item.value, 0);

	return (
		<div className="flex flex-col items-center gap-3" role="group" aria-label={ariaLabel}>
			<div className="relative" style={{ width: "100%", height }}>
				<ResponsiveContainer width="100%" height="100%">
					<RPieChart>
						<Pie
							data={pieData}
							dataKey="value"
							nameKey="name"
							innerRadius="58%"
							outerRadius="82%"
							paddingAngle={pieData.length > 1 ? 2 : 0}
							stroke={c.surface}
							strokeWidth={2}
							isAnimationActive={false}
						>
							{pieData.map((item, i) => (
								<Cell key={item.id} fill={sliceColor(i)} />
							))}
						</Pie>
						<Tooltip content={<PieTooltip unitLabel={tasksLabel} linesLabel={linesLabel} />} />
					</RPieChart>
				</ResponsiveContainer>
				<div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
					<div className="text-fg text-2xl font-bold tabular-nums leading-none">{total}</div>
					<div className="text-fg-3 text-dense">{totalLabel}</div>
				</div>
			</div>
			<div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 w-full" role="list">
				{data.map((item, i) => (
					<div key={item.id} className="flex items-start gap-1.5 min-w-0" role="listitem">
						<span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: sliceColor(i) }} aria-hidden="true" />
						<span className="text-fg-2 text-xs leading-tight break-words flex-1 min-w-0" title={item.name}>{item.name}</span>
						<span className="text-fg-muted text-micro tabular-nums flex-shrink-0">{item.completed}</span>
					</div>
				))}
			</div>
		</div>
	);
}

export default BreakdownPie;
