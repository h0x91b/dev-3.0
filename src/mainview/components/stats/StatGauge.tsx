import { Gauge } from "../gauges/Gauge";

interface StatGaugeProps {
	value: number;
	max: number;
	redZone?: number;
	/** Short label rendered inside the gauge face. */
	label: string;
	/** Unit rendered inside the gauge face under the label. */
	unit?: string;
	/** Caption shown below the gauge. */
	caption: string;
	/** Pre-formatted big number shown below; defaults to the compact value. */
	displayValue?: string;
	/** Trend vs previous period (%). Null/undefined hides the trend chip. */
	trendPct?: number | null;
	/** Localized "vs previous period" suffix for the trend chip tooltip/label. */
	trendSuffix?: string;
	size?: number;
}

function compact(n: number): string {
	return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/**
 * One hero metric: the user's speedometer Gauge in a card, with a big numeric
 * readout, caption, and a trend chip vs the previous period. The Gauge is reused
 * verbatim (its own styling); the card chrome uses semantic design tokens.
 */
export function StatGauge({
	value,
	max,
	redZone,
	label,
	unit,
	caption,
	displayValue,
	trendPct,
	trendSuffix,
	size = 168,
}: StatGaugeProps) {
	const hasTrend = trendPct != null;
	const up = (trendPct ?? 0) >= 0;
	return (
		<div className="flex flex-col items-center gap-2 rounded-2xl border border-edge bg-raised px-4 py-4">
			<Gauge value={value} max={max} redZone={redZone} label={label} unit={unit} size={size} theme="auto" />
			<div className="flex flex-col items-center gap-0.5 mt-1">
				<div className="text-fg text-xl font-bold tabular-nums leading-none">{displayValue ?? compact(value)}</div>
				<div className="text-fg-3 text-xs">{caption}</div>
				{hasTrend && (
					<div
						className={`mt-0.5 inline-flex items-center gap-1 text-[0.6875rem] font-semibold tabular-nums ${
							up ? "text-success" : "text-danger"
						}`}
						title={trendSuffix}
					>
						<span>{up ? "▲" : "▼"}</span>
						<span>{Math.abs(trendPct ?? 0)}%</span>
						{trendSuffix && <span className="text-fg-muted font-normal">{trendSuffix}</span>}
					</div>
				)}
			</div>
		</div>
	);
}

export default StatGauge;
