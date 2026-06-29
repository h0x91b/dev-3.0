import { Cell, Pie, PieChart as RPieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { PerAgentStat } from "../../utils/productivityStats";
import { PieTooltip } from "./ChartTooltip";
import { useChartColors } from "./useChartColors";

interface AgentPieProps {
	data: PerAgentStat[];
	height?: number;
	/** Unit label for the donut center + tooltip (e.g. "tasks"). */
	tasksLabel: string;
	/** Label for the LOC line in the tooltip (e.g. "LOC"). */
	linesLabel: string;
	/** Centered total caption (e.g. "shipped"). */
	totalLabel: string;
}

/**
 * Donut breakdown of tasks shipped per agent type, with a hover tooltip, a
 * centered total, and a token-themed legend. Slice colors come from the
 * categorical chart palette (resolved via {@link useChartColors}).
 */
export function AgentPie({ data, height = 200, tasksLabel, linesLabel, totalLabel }: AgentPieProps) {
	const c = useChartColors();
	const sliceColor = (i: number) => c.slices[i % c.slices.length];
	const pieData = data.map((a) => ({ name: a.name, value: a.completed, lines: a.lines, sharePct: a.sharePct }));
	const total = pieData.reduce((s, d) => s + d.value, 0);

	return (
		<div className="flex flex-col items-center gap-3">
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
							{pieData.map((_, i) => (
								<Cell key={i} fill={sliceColor(i)} />
							))}
						</Pie>
						<Tooltip content={<PieTooltip unitLabel={tasksLabel} linesLabel={linesLabel} />} />
					</RPieChart>
				</ResponsiveContainer>
				{/* Centered total inside the donut hole */}
				<div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
					<div className="text-fg text-2xl font-bold tabular-nums leading-none">{total}</div>
					<div className="text-fg-3 text-[0.625rem]">{totalLabel}</div>
				</div>
			</div>
			{/* Legend */}
			<div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 w-full">
				{data.map((a, i) => (
					<div key={a.agentId} className="flex items-center gap-1.5 min-w-0">
						<span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: sliceColor(i) }} />
						<span className="text-fg-2 text-xs truncate flex-1">{a.name}</span>
						<span className="text-fg-muted text-[0.6875rem] tabular-nums flex-shrink-0">{a.completed}</span>
					</div>
				))}
			</div>
		</div>
	);
}

export default AgentPie;
