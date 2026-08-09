import { useT } from "../i18n";

interface CanaryBadgeProps {
	/** Short commit the build was cut from — the only thing telling two canary builds apart. */
	sha: string;
	/** Full published version, shown on hover. */
	fullVersion?: string;
}

/**
 * Marks a version string as belonging to a canary build rather than the stable release
 * of the same number.
 *
 * NEUTRAL TOKENS ON PURPOSE. This is provenance, not an alert and not an action: accent
 * in the update popover already belongs to the Restart button, and spending it here would
 * flatten the one real call to action. It is also deliberately NOT a header chip — the
 * header's ambient-readout budget is one and memory headroom owns it, so the channel is
 * named where a version is already being shown and nowhere else.
 */
export default function CanaryBadge({ sha, fullVersion }: CanaryBadgeProps) {
	const t = useT();
	return (
		<span
			title={t("update.canaryBadgeTooltip", { version: fullVersion ?? sha })}
			className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-raised border border-edge text-fg-3 text-micro align-middle"
		>
			{t("update.canaryBadge")}
			<span className="font-mono">{sha}</span>
		</span>
	);
}
