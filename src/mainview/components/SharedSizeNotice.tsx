import { useT } from "../i18n";
import Tooltip from "./Tooltip";

/**
 * Floating notice over a tmux terminal that is sized for ANOTHER viewer
 * (h0x91b/dev-3.0#2000). The shared PTY follows the viewer used last, so this
 * one renders at that viewer's grid — cropped or letterboxed — until the user
 * clicks or types here.
 *
 * An overlay, never a row: a strip above the canvas changed the terminal's own
 * height, so the viewport it reported while following was a row short the
 * moment it took the size over and the strip went away.
 *
 * The WHOLE pill is the button, at a 44px touch height and pinned to the top:
 * a small "Fit here" chip at the bottom edge was missed on phones, where a tap
 * that low lands on the label or reopens Safari's toolbar instead.
 */
function SharedSizeNotice({ onFitHere }: { onFitHere: () => void }) {
	const t = useT();
	return (
		<Tooltip content={t("sharedSize.fitHereHint")} placement="bottom">
			<button
				type="button"
				onClick={onFitHere}
				className="absolute left-1/2 top-2 z-20 flex min-h-11 max-w-[calc(100%-1rem)] -translate-x-1/2 touch-manipulation items-center gap-2 rounded-full border border-edge-active bg-overlay/95 py-1.5 pl-4 pr-1.5 text-xs text-fg-2 shadow-lg shadow-black/40 transition-transform active:scale-[0.96]"
			>
				<span className="truncate">{t("sharedSize.sizedElsewhere")}</span>
				<span className="shrink-0 rounded-full bg-accent-fill px-3 py-1 font-medium text-white">{t("sharedSize.fitHere")}</span>
			</button>
		</Tooltip>
	);
}

export default SharedSizeNotice;
