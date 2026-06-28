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
 * Lightweight responsive bar chart (flex divs, no SVG, no chart lib). Bars are
 * accent-tinted and scale to the max value. Theme-aware via design tokens.
 */
export function BarChart({ data, height = 160, formatValue = (n) => String(n), emptyLabel }: BarChartProps) {
	const max = Math.max(1, ...data.map((d) => d.value));
	const total = data.reduce((s, d) => s + d.value, 0);
	// Sparse x labels when there are many buckets, so they don't overlap.
	const labelEvery = data.length <= 14 ? 1 : Math.ceil(data.length / 10);

	if (total === 0 && emptyLabel) {
		return (
			<div className="flex items-center justify-center text-fg-muted text-xs" style={{ height }}>
				{emptyLabel}
			</div>
		);
	}

	return (
		<div>
			<div className="flex items-end gap-[3px]" style={{ height }}>
				{data.map((d, i) => {
					const pct = (d.value / max) * 100;
					return (
						<div
							key={d.startMs}
							className="group flex-1 flex flex-col justify-end items-stretch h-full min-w-0"
							title={`${d.label}: ${formatValue(d.value)}`}
						>
							<div
								className="w-full rounded-t-[3px] bg-accent/70 group-hover:bg-accent transition-colors"
								style={{ height: `${Math.max(d.value > 0 ? 2 : 0, pct)}%` }}
							/>
							{labelEvery > 0 && i % labelEvery === 0 && (
								<div className="mt-1 text-center text-[0.5625rem] text-fg-muted truncate">{d.label}</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export default BarChart;
