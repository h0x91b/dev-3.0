import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import BottomSheet from "./BottomSheet";
import type { StatusMenu } from "../hooks/useStatusMenu";

interface StatusMenuPortalProps {
	menu: StatusMenu;
	narrow: boolean;
	/** Bottom-sheet heading; the desktop popover is anchored and needs none. */
	title: string;
	sheetTestId?: string;
	children: ReactNode;
}

/**
 * The Move-to menu's container: a bottom sheet under the narrow breakpoint, an
 * anchored portal above it. The wrapper stops clicks bubbling through the portal
 * back into the card or sidebar row that opened it.
 */
export default function StatusMenuPortal({ menu, narrow, title, sheetTestId, children }: StatusMenuPortalProps) {
	if (!menu.open) return null;

	if (narrow) {
		return (
			<div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
				<BottomSheet open onClose={() => menu.setOpen(false)} title={title} testId={sheetTestId}>
					{children}
				</BottomSheet>
			</div>
		);
	}

	return createPortal(
		<div
			ref={menu.menuRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]"
			style={{ top: menu.pos.top, left: menu.pos.left, visibility: menu.visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			{children}
		</div>,
		document.body,
	);
}
