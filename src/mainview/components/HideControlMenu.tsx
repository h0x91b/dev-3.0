import { createPortal } from "react-dom";
import { useT } from "../i18n";

/** The one-item "Hide" menu opened by `useHideContextMenu`. Render right after the control it targets. */
export default function HideControlMenu({
	open,
	pos,
	onHide,
	onClose,
}: {
	open: boolean;
	pos: { top: number; left: number } | null;
	onHide: () => void;
	onClose: () => void;
}) {
	const t = useT();
	if (!open || !pos) return null;

	return createPortal(
		<>
			<div
				className="fixed inset-0 z-[200]"
				onClick={onClose}
				onContextMenu={(e) => {
					e.preventDefault();
					onClose();
				}}
			/>
			<div
				role="menu"
				className="fixed z-[201] min-w-[8rem] rounded-lg border border-edge bg-overlay py-1 shadow-2xl"
				style={{ top: pos.top, left: pos.left }}
			>
				<button
					type="button"
					role="menuitem"
					onClick={onHide}
					className="w-full text-left px-3 py-1.5 text-xs text-fg-2 hover:bg-elevated hover:text-fg transition-colors"
				>
					{t("hideableControls.hide")}
				</button>
			</div>
		</>,
		document.body,
	);
}
