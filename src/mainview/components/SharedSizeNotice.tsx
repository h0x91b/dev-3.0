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
 */
function SharedSizeNotice({ onFitHere }: { onFitHere: () => void }) {
	const t = useT();
	return (
		<div
			role="status"
			className="absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-edge-active bg-overlay/95 py-1 pl-3 pr-1 text-xs text-fg-2 shadow-lg shadow-black/40"
		>
			<span className="truncate">{t("sharedSize.sizedElsewhere")}</span>
			<Tooltip content={t("sharedSize.fitHereHint")} placement="top">
				<button
					type="button"
					onClick={onFitHere}
					className="shrink-0 rounded-full bg-accent-fill px-2.5 py-0.5 font-medium text-white transition-[background-color,transform] hover:bg-accent-fill-hover active:scale-[0.96]"
				>
					{t("sharedSize.fitHere")}
				</button>
			</Tooltip>
		</div>
	);
}

export default SharedSizeNotice;
