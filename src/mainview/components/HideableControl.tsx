import type { ReactNode } from "react";
import { useT } from "../i18n";
import { useHideContextMenu } from "../hooks/useHideContextMenu";
import HideControlMenu from "./HideControlMenu";
import { hideControl } from "../hidden-controls";
import type { HideableControlId } from "../hideable-controls";
import { EyeIcon } from "./TaskIcons";

/**
 * Wraps a control with the desktop right-click "Hide" affordance
 * (PRODUCT_UX_BIBLE.md §5.10 §2.2). `display: contents` keeps the wrapper out
 * of layout entirely, so it is safe inside a flex bar.
 */
export default function HideableControl({ id, children }: { id: HideableControlId; children: ReactNode }) {
	const { open, pos, onContextMenu, onHide, close } = useHideContextMenu(id);
	return (
		<span onContextMenu={onContextMenu} style={{ display: "contents" }}>
			{children}
			<HideControlMenu open={open} pos={pos} onHide={onHide} onClose={close} />
		</span>
	);
}

/**
 * Touch/remote equivalent: no right click there (§2.2), so a row already
 * inside an overflow/action sheet gets a small, always-visible hide icon
 * instead of a hover-revealed one.
 */
export function HideRowButton({ id }: { id: HideableControlId }) {
	const t = useT();
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				hideControl(id);
			}}
			aria-label={t("hideableControls.hide")}
			className="flex-shrink-0 p-1.5 rounded text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors"
		>
			<EyeIcon off className="w-4 h-4" />
		</button>
	);
}
