import { useT } from "../i18n";
import Tooltip from "./Tooltip";

/**
 * Slim strip above a tmux terminal that is sized for ANOTHER viewer
 * (h0x91b/dev-3.0#2000). The shared PTY follows the viewer used last, so this
 * one renders at that viewer's grid — cropped or letterboxed — until the user
 * clicks or types here. Same slot and look as NativeViewerBar; the viewer the
 * terminal is sized for sees no chrome at all.
 */
function SharedSizeBar({ onFitHere }: { onFitHere: () => void }) {
	const t = useT();
	return (
		<div
			role="status"
			className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-raised px-3 py-1 text-xs text-fg-3"
		>
			<span className="truncate">{t("sharedSize.sizedElsewhere")}</span>
			<Tooltip content={t("sharedSize.fitHereHint")} placement="bottom">
				<button
					type="button"
					onClick={onFitHere}
					className="shrink-0 rounded border border-edge bg-elevated px-2 py-0.5 font-medium text-fg-2 transition-colors hover:border-edge-active hover:bg-elevated-hover hover:text-fg"
				>
					{t("sharedSize.fitHere")}
				</button>
			</Tooltip>
		</div>
	);
}

export default SharedSizeBar;
