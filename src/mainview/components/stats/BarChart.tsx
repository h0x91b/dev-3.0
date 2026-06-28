import { Bar, BarChart as RBarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SeriesTooltip } from "./ChartTooltip";
import { useChartColors } from "./useChartColors";

interface BarDatum {
	label: string;
	value: number;
	startMs: number;
}

interface BarChartProps {
	data: BarDatum[];
	height?: number;
	/** Format a bar's value for the hover tooltip. */
	formatValue?: (n: number) => string;
	emptyLabel?: string;
}

/**
 * Responsive bar chart (recharts). Accent bars with a hover tooltip; axis and
 * grid use design tokens (resolved via {@link useChartColors}) so it tracks the
 * active theme.
 */
export function BarChart({ data, height = 180, formatValue = (n) => String(n), emptyLabel }: BarChartProps) {
	const c = useChartColors();
	const total = data.reduce((s, d) => s + d.value, 0);
	if (total === 0 && emptyLabel) {
		return (
			<div className="flex items-center justify-center text-fg-muted text-xs" style={{ height }}>
				{emptyLabel}
			</div>
		);
	}

	// Thin out x-axis labels so they never collide.
	const interval = data.length <= 14 ? 0 : Math.ceil(data.length / 8) - 1;

	return (
		<ResponsiveContainer width="100%" height={height}>
			<RBarChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 6 }} barCategoryGap="18%">
				<CartesianGrid vertical={false} stroke={c.grid} strokeOpacity={0.5} />
				<XAxis
					dataKey="label"
					interval={interval}
					tickLine={false}
					axisLine={false}
					tick={{ fill: c.axis, fontSize: 10 }}
				/>
				<YAxis hide domain={[0, "dataMax"]} />
				<Tooltip
					cursor={{ fill: `rgb(${c.accentRaw} / 0.1)` }}
					content={<SeriesTooltip formatValue={formatValue} />}
				/>
				<Bar dataKey="value" radius={[3, 3, 0, 0]} fill={c.accent} maxBarSize={48} isAnimationActive={false} />
			</RBarChart>
		</ResponsiveContainer>
	);
}

export default BarChart;
