import { useState, useRef, useEffect, useLayoutEffect, type RefObject } from "react";

export interface StatusMenu {
	open: boolean;
	setOpen: (open: boolean) => void;
	/** Trigger click handler — stops propagation so the host row/card stays put. */
	toggle: (e: React.MouseEvent) => void;
	triggerRef: RefObject<HTMLButtonElement | null>;
	menuRef: RefObject<HTMLDivElement | null>;
	pos: { top: number; left: number };
	/** False for the first layout pass, while the menu is measured off-screen. */
	visible: boolean;
}

/**
 * Anchored Move-to menu state shared by the Kanban card and the Active Tasks
 * sidebar: open/close, click-outside, and viewport clamping. Both surfaces mount
 * the same lifecycle rail, so they must not each own a copy of this.
 */
export function useStatusMenu(narrow: boolean): StatusMenu {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				triggerRef.current &&
				!triggerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	// Crossing the narrow breakpoint must not strand the open menu — it renders
	// as a bottom sheet on narrow and an anchored popover on desktop.
	useEffect(() => {
		setOpen(false);
	}, [narrow]);

	// After the menu renders (invisible), measure and clamp it into the viewport.
	useLayoutEffect(() => {
		if (!open || !menuRef.current || !triggerRef.current) return;

		const menu = menuRef.current.getBoundingClientRect();
		const trigger = triggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = trigger.bottom + 6;
		let left = trigger.left;

		if (top + menu.height > vh - pad) top = trigger.top - menu.height - 6;
		if (left + menu.width > vw - pad) left = vw - menu.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
	}, [open]);

	function toggle(e: React.MouseEvent) {
		e.stopPropagation();
		if (!open && triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setPos({ top: rect.bottom + 6, left: rect.left });
			setVisible(false);
		}
		setOpen(!open);
	}

	return { open, setOpen, toggle, triggerRef, menuRef, pos, visible };
}
