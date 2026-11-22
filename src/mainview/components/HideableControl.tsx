import type { ReactNode } from "react";
import { useT } from "../i18n";
import { useHideContextMenu } from "../hooks/useHideContextMenu";
import ControlMenu from "./ControlMenu";
import type { HideableControlId } from "../hideable-controls";

/**
 * Wraps a global-header control with the desktop right-click "Hide" affordance
 * (PRODUCT_UX_BIBLE.md §5.10 §2.2). `display: contents` keeps the wrapper out
 * of layout entirely, so it is safe inside a flex bar. Task-header items get
 * their menu from the header host instead (`task-header/item-menu.tsx`).
 */
export default function HideableControl({ id, children }: { id: HideableControlId; children: ReactNode }) {
	const t = useT();
	const { pos, onContextMenu, onHide, close } = useHideContextMenu(id);
	return (
		<span onContextMenu={onContextMenu} style={{ display: "contents" }}>
			{children}
			{pos && <ControlMenu pos={pos} onClose={close} entries={[{ key: "hide", label: t("hideableControls.hide"), onSelect: onHide }]} />}
		</span>
	);
}
