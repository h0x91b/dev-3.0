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

const VW = 1000; // virtual viewBox width; preserveAspectRatio="none" stretches it

/**
 * Lightweight responsive area/line chart (pure SVG, no chart lib). Accent line
 * with a soft accent fill. Theme-aware via `currentColor` (set by `text-accent`).
 */
export function AreaChart({ data, height = 160, formatValue = (n) => String(n), emptyLabel }: AreaChartProps) {
	const total = data.reduce((s, d) => s + d.value, 0);
	if ((data.length === 0 || total === 0) && emptyLabel) {
		return (
			<div className="flex items-center justify-center text-fg-muted text-xs" style={{ height }}>
				{emptyLabel}
			</div>
		);
	}

	const VH = 100;
	const pad = 6;
	const max = Math.max(1, ...data.map((d) => d.value));
	const n = data.length;
	const x = (i: number) => (n <= 1 ? VW / 2 : (i / (n - 1)) * VW);
	const y = (v: number) => VH - pad - (v / max) * (VH - 2 * pad);

	const linePts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(2)}`);
	const linePath = n === 1 ? `M0,${y(data[0].value).toFixed(2)} L${VW},${y(data[0].value).toFixed(2)}` : `M${linePts.join(" L")}`;
	const areaPath = `${linePath} L${VW},${VH} L0,${VH} Z`;

	const labelEvery = n <= 14 ? 1 : Math.ceil(n / 10);

	return (
		<div className="text-accent">
			<svg width="100%" height={height} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" role="img">
				<path d={areaPath} fill="currentColor" fillOpacity={0.12} />
				<path
					d={linePath}
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinejoin="round"
					strokeLinecap="round"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			<div className="flex gap-[3px] mt-1">
				{data.map((d, i) => (
					<div key={d.startMs} className="flex-1 min-w-0 text-center text-[0.5625rem] text-fg-muted truncate" title={`${d.label}: ${formatValue(d.value)}`}>
						{i % labelEvery === 0 ? d.label : ""}
					</div>
				))}
			</div>
		</div>
	);
}

export default AreaChart;
