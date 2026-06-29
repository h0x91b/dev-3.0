interface SeriesTooltipProps {
	active?: boolean;
	payload?: Array<{ value: number; payload: Record<string, unknown> }>;
	label?: string | number;
	formatValue?: (n: number) => string;
}

/**
 * Themed tooltip for the series charts (bar/area). recharts injects
 * `active`/`payload`/`label`; `formatValue` is supplied at the call site and
 * preserved when recharts clones the element.
 */
export function SeriesTooltip({ active, payload, label, formatValue = (n) => String(n) }: SeriesTooltipProps) {
	if (!active || !payload || payload.length === 0) return null;
	return (
		<div className="rounded-lg border border-edge bg-overlay px-2.5 py-1.5 shadow-xl pointer-events-none">
			{label != null && <div className="text-fg-3 text-[0.625rem] mb-0.5">{label}</div>}
			<div className="text-fg text-xs font-semibold tabular-nums">{formatValue(payload[0].value)}</div>
		</div>
	);
}

interface PieTooltipProps {
	active?: boolean;
	payload?: Array<{ payload: { name: string; value: number; lines: number; sharePct: number } }>;
	unitLabel?: string;
	linesLabel?: string;
}

/** Themed tooltip for the per-agent pie: agent name, task count + share, LOC. */
export function PieTooltip({ active, payload, unitLabel = "", linesLabel = "" }: PieTooltipProps) {
	if (!active || !payload || payload.length === 0) return null;
	const d = payload[0].payload;
	return (
		<div className="rounded-lg border border-edge bg-overlay px-2.5 py-1.5 shadow-xl pointer-events-none">
			<div className="text-fg text-xs font-semibold">{d.name}</div>
			<div className="text-fg-3 text-[0.6875rem] tabular-nums">
				{d.value} {unitLabel} · {d.sharePct}%
			</div>
			<div className="text-fg-muted text-[0.625rem] tabular-nums">
				{Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(d.lines)} {linesLabel}
			</div>
		</div>
	);
}
