import type { MilestoneInfo } from "../../utils/productivityStats";

interface MilestonesProps extends MilestoneInfo {
	/** Format a tier value (e.g. 1000 → "1K"). */
	format: (n: number) => string;
	/** "Next" caption for the chase chip. */
	nextLabel: string;
	/** Tooltip for an earned medal. */
	tooltipReached: (tier: number) => string;
	/** Tooltip for the next (locked) tier. */
	tooltipNext: (tier: number) => string;
}

const ICON = "'JetBrainsMono Nerd Font Mono'";
const TROPHY = "\u{F0699}";

/**
 * Lifetime shipping medals: a gold chip per earned tier, plus a muted "next"
 * chip with a progress bar from the last earned tier to the one being chased.
 */
export function Milestones({ reached, next, current, format, nextLabel, tooltipReached, tooltipNext }: MilestonesProps) {
	const base = reached.length > 0 ? Math.max(...reached) : 0;
	const pct = next != null && next > base ? Math.min(100, Math.max(0, ((current - base) / (next - base)) * 100)) : 0;

	return (
		<div className="flex flex-wrap items-stretch gap-2">
			{reached.map((tier) => (
				<div
					key={tier}
					title={tooltipReached(tier)}
					className="inline-flex items-center gap-1.5 rounded-xl border border-stat-gold/40 bg-stat-gold/10 px-3 py-2"
				>
					<span className="text-stat-gold text-base leading-none" style={{ fontFamily: ICON }}>{TROPHY}</span>
					<span className="text-stat-gold text-sm font-bold tabular-nums">{format(tier)}</span>
				</div>
			))}

			{next != null && (
				<div
					title={tooltipNext(next)}
					className="inline-flex items-center gap-2 rounded-xl border border-edge bg-raised px-3 py-2 min-w-[150px]"
				>
					<span className="text-fg-muted text-base leading-none" style={{ fontFamily: ICON }}>{TROPHY}</span>
					<div className="flex flex-col gap-1 min-w-0 flex-1">
						<span className="text-fg-3 text-[0.6875rem] whitespace-nowrap">
							{nextLabel}: <span className="font-semibold text-fg-2">{format(next)}</span>
						</span>
						<div className="h-1 w-full rounded-full bg-elevated overflow-hidden">
							<div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${pct}%` }} />
						</div>
						<span className="text-fg-muted text-[0.625rem] tabular-nums">{current} / {format(next)}</span>
					</div>
				</div>
			)}
		</div>
	);
}

export default Milestones;
