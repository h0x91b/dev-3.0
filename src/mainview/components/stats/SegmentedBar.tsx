import { useAnimatedNumber } from "../../utils/useAnimatedNumber";

interface SegmentedBarProps {
	value: number;
	max: number;
	/** Number of discrete segments (LED cells). Default 20. */
	segments?: number;
	/**
	 * Optional "beat-your-average" threshold. Lit segments on the achievement
	 * side render at full accent; the rest dim. See {@link redZoneMode}.
	 */
	redZone?: number;
	/** Which side of `redZone` is the bright "beat" zone. Default "above". */
	redZoneMode?: "above" | "below";
	/** Segment height in px. Default 10. */
	height?: number;
	ariaLabel?: string;
}

/**
 * LED-meter style progress bar: a row of discrete segments that light up to the
 * value. Accent-filled, theme-aware via design tokens. When `redZone` is set,
 * lit segments past the threshold glow full-accent while the rest dim, so
 * over-average output stands out — matching the gauges' red-zone semantics.
 */
export function SegmentedBar({
	value,
	max,
	segments = 20,
	redZone,
	redZoneMode = "above",
	height = 10,
	ariaLabel,
}: SegmentedBarProps) {
	// Grow the lit segments in on mount; the aria value stays the real target.
	const animated = useAnimatedNumber(value);
	const ratio = max > 0 ? Math.min(1, Math.max(0, animated / max)) : 0;
	const lit = Math.round(ratio * segments);
	const hasRed = redZone != null;

	return (
		<div
			className="flex items-center gap-[2px] w-full"
			role="meter"
			aria-label={ariaLabel}
			aria-valuenow={value}
			aria-valuemin={0}
			aria-valuemax={max}
		>
			{Array.from({ length: segments }, (_, i) => {
				const isLit = i < lit;
				// Value this segment represents at its top edge.
				const repValue = ((i + 1) / segments) * max;
				const inBeat = hasRed && (redZoneMode === "below" ? repValue <= redZone : repValue >= redZone);
				const cls = isLit ? (hasRed ? (inBeat ? "bg-accent" : "bg-accent/45") : "bg-accent") : "bg-elevated";
				return <div key={i} className={`flex-1 rounded-[2px] transition-colors ${cls}`} style={{ height }} />;
			})}
		</div>
	);
}

export default SegmentedBar;
