import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useViewportClamp } from "../hooks/useViewportClamp";

/** One row. A row with `submenu` swaps the menu's rows for that list, with a Back row first. */
export interface ControlMenuEntry {
	key: string;
	label: string;
	onSelect?: () => void;
	disabled?: boolean;
	/** Draws a divider above the row. */
	separated?: boolean;
	submenu?: readonly ControlMenuEntry[];
}

const ROW_CLASS = "w-full text-left px-3 py-1.5 [@media(pointer:coarse)]:min-h-[44px] text-xs text-fg-2 hover:bg-overlay-hover hover:text-fg focus-visible:bg-overlay-hover focus-visible:text-fg focus-visible:outline-none transition-colors disabled:opacity-40 disabled:pointer-events-none";

function enabledRows(menu: HTMLElement | null): HTMLElement[] {
	return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
}

/**
 * The right-click menu of a hideable control (PRODUCT_UX_BIBLE.md §5.10): a portaled
 * `role="menu"` at the pointer, kept inside the viewport. Keyboard: focus starts on the
 * first row; arrows, Home and End move; Escape and Tab close. Closing hands focus back
 * through `onClose`, which the opener points at the control it came from.
 */
export default function ControlMenu({
	pos,
	entries,
	onClose,
	label,
}: {
	pos: { top: number; left: number };
	entries: readonly ControlMenuEntry[];
	onClose: () => void;
	/** The control's name, read out as the menu's label. */
	label?: string;
}) {
	const t = useT();
	const [submenu, setSubmenu] = useState<ControlMenuEntry | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const { position, visible } = useViewportClamp(menuRef, pos, submenu?.key);
	const rows = submenu ? [{ key: "back", label: t("controlMenu.back"), onSelect: () => setSubmenu(null) }, ...(submenu.submenu ?? [])] : entries;

	useEffect(() => {
		enabledRows(menuRef.current)[0]?.focus();
	}, [submenu]);

	function onKeyDown(e: ReactKeyboardEvent) {
		if (e.key === "Escape" || e.key === "Tab") {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			return;
		}
		const items = enabledRows(menuRef.current);
		if (items.length === 0) return;
		const current = items.indexOf(document.activeElement as HTMLElement);
		let next: number | null = null;
		if (e.key === "ArrowDown") next = (current + 1) % items.length;
		else if (e.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = items.length - 1;
		if (next === null) return;
		e.preventDefault();
		items[next].focus();
	}

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
				ref={menuRef}
				role="menu"
				aria-label={submenu?.label ?? label}
				onKeyDown={onKeyDown}
				className="fixed z-[201] min-w-[10rem] max-w-[18rem] max-h-[70vh] overflow-y-auto rounded-lg border border-edge bg-overlay py-1 shadow-2xl"
				style={{ top: position.top, left: position.left, visibility: visible ? "visible" : "hidden" }}
			>
				{rows.map((entry) => (
					<div key={entry.key} role="none">
						{entry.separated && <div className="my-1 border-t border-edge" role="separator" />}
						<button
							type="button"
							role="menuitem"
							aria-haspopup={entry.submenu ? "menu" : undefined}
							disabled={entry.disabled}
							onClick={() => {
								if (entry.submenu) {
									setSubmenu(entry);
									return;
								}
								entry.onSelect?.();
								if (entry.key !== "back") onClose();
							}}
							className={`${ROW_CLASS} flex items-center gap-2`}
						>
							{entry.key === "back" && <span aria-hidden="true">‹</span>}
							<span className="flex-1 truncate">{entry.label}</span>
							{entry.submenu && <span aria-hidden="true" className="text-fg-muted">›</span>}
						</button>
					</div>
				))}
			</div>
		</>,
		document.body,
	);
}
