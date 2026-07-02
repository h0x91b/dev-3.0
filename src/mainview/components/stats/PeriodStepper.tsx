const ICON = "'JetBrainsMono Nerd Font Mono'";
const CHEVRON_LEFT = "\u{F0141}";
const CHEVRON_RIGHT = "\u{F0142}";

interface PeriodStepperProps {
	/** The period label shown between the arrows (e.g. "This week", "3 weeks ago"). */
	label: string;
	/** Tooltip for the label button (exact date range, plus a reset hint when in the past). */
	labelTitle: string;
	/** Accessible group name. */
	groupLabel: string;
	/** True when viewing the current period (label click is a no-op / disabled). */
	atCurrent: boolean;
	/** Enable the "older" (‹) arrow. */
	canOlder: boolean;
	/** Enable the "newer" (›) arrow. */
	canNewer: boolean;
	onOlder: () => void;
	onNewer: () => void;
	onReset: () => void;
	prevLabel: string;
	nextLabel: string;
}

/**
 * Period navigator for the stats cockpit — steps the time-range window one
 * period into the past (‹) or back toward now (›). A temporal extension of the
 * {@link TimeRangeSwitch} on the same axis; stays read-only (no config, no
 * mutation) and the center label resets to the current period on click.
 */
export function PeriodStepper({
	label,
	labelTitle,
	groupLabel,
	atCurrent,
	canOlder,
	canNewer,
	onOlder,
	onNewer,
	onReset,
	prevLabel,
	nextLabel,
}: PeriodStepperProps) {
	const arrowCls =
		"px-1.5 py-1 rounded-md text-fg-3 transition-colors enabled:hover:text-fg enabled:hover:bg-elevated disabled:opacity-30 disabled:cursor-not-allowed";
	return (
		<div
			className="inline-flex items-center gap-0.5 rounded-lg border border-edge bg-raised p-0.5"
			role="group"
			aria-label={groupLabel}
		>
			<button type="button" onClick={onOlder} disabled={!canOlder} aria-label={prevLabel} title={prevLabel} className={arrowCls}>
				<span className="text-sm leading-none" style={{ fontFamily: ICON }}>{CHEVRON_LEFT}</span>
			</button>
			<button
				type="button"
				onClick={onReset}
				disabled={atCurrent}
				title={labelTitle}
				className="min-w-[6.5rem] px-2 py-1 text-center text-xs font-semibold text-fg rounded-md transition-colors enabled:hover:bg-elevated disabled:cursor-default"
			>
				{label}
			</button>
			<button type="button" onClick={onNewer} disabled={!canNewer} aria-label={nextLabel} title={nextLabel} className={arrowCls}>
				<span className="text-sm leading-none" style={{ fontFamily: ICON }}>{CHEVRON_RIGHT}</span>
			</button>
		</div>
	);
}

export default PeriodStepper;
