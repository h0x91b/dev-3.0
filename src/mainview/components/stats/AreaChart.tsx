import { Area, AreaChart as RAreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SeriesTooltip } from "./ChartTooltip";
import { useChartColors } from "./useChartColors";

interface AreaDatum {
	label: string;
	value: number;
	startMs: number;
}

interface AreaChartProps {
	data: AreaDatum[];
	height?: number;
	formatValue?: (n: number) => string;
	emptyLabel?: string;
}

const GRAD_ID = "stats-area-fill";

/**
 * Responsive area/line chart (recharts). Accent line over a soft accent
 * gradient, with a hover tooltip. Theme-aware via {@link useChartColors}.
 */
export function AreaChart({ data, height = 180, formatValue = (n) => String(n), emptyLabel }: AreaChartProps) {
	const c = useChartColors();
	const total = data.reduce((s, d) => s + d.value, 0);
	if ((data.length === 0 || total === 0) && emptyLabel) {
		return (
			<div className="flex items-center justify-center text-fg-muted text-xs" style={{ height }}>
				{emptyLabel}
			</div>
		);
	}

	const interval = data.length <= 14 ? 0 : Math.ceil(data.length / 8) - 1;

	return (
		<ResponsiveContainer width="100%" height={height}>
			<RAreaChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 6 }}>
				<defs>
					<linearGradient id={GRAD_ID} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor={`rgb(${c.accentRaw} / 0.35)`} />
						<stop offset="100%" stopColor={`rgb(${c.accentRaw} / 0.02)`} />
					</linearGradient>
				</defs>
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
					cursor={{ stroke: c.accent, strokeOpacity: 0.4 }}
					content={<SeriesTooltip formatValue={formatValue} />}
				/>
				<Area
					type="monotone"
					dataKey="value"
					stroke={c.accent}
					strokeWidth={2}
					fill={`url(#${GRAD_ID})`}
					isAnimationActive={false}
				/>
			</RAreaChart>
		</ResponsiveContainer>
	);
}

export default AreaChart;
