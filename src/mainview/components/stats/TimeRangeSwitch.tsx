import type { StatsRange } from "../../utils/productivityStats";
import { STATS_RANGES } from "../../utils/productivityStats";

interface TimeRangeSwitchProps {
	value: StatsRange;
	onChange: (range: StatsRange) => void;
	labels: Record<StatsRange, string>;
}

/** Segmented control for the dashboard time range (Day / Week / Month / All). */
export function TimeRangeSwitch({ value, onChange, labels }: TimeRangeSwitchProps) {
	return (
		<div className="inline-flex items-center gap-0.5 rounded-lg border border-edge bg-raised p-0.5" role="tablist">
			{STATS_RANGES.map((r) => {
				const active = r === value;
				return (
					<button
						key={r}
						type="button"
						role="tab"
						aria-selected={active}
						onClick={() => onChange(r)}
						className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
							active ? "bg-accent text-white" : "text-fg-3 hover:text-fg hover:bg-elevated"
						}`}
					>
						{labels[r]}
					</button>
				);
			})}
		</div>
	);
}

export default TimeRangeSwitch;
