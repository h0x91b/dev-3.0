import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskCompletionOwner } from "../../shared/types";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";
import { useOverlayLayer } from "../utils/useOverlayLayer";

const OWNERS: Array<{ owner: TaskCompletionOwner; label: TranslationKey; detail: TranslationKey }> = [
	{ owner: "dev3", label: "task.completionOwnerDev3", detail: "task.completionOwnerDev3Detail" },
	{ owner: "user", label: "task.manualCompletion", detail: "task.manualCompletionConsequence" },
	{ owner: "agent", label: "task.selfCompletionEnabled", detail: "task.selfCompletionConsequence" },
];

interface CompletionOwnerMenuProps {
	selected: TaskCompletionOwner;
	onSelect: (owner: TaskCompletionOwner) => void;
	onClose: () => void;
	anchorEl: HTMLElement;
}

/**
 * Anchored menu for who completes a task. A menu rather than a click-to-cycle
 * chip: the third owner lets the agent destroy the worktree unasked, so no
 * habitual click may land on it. Positioning mirrors {@link PriorityPicker}.
 */
function CompletionOwnerMenu({ selected, onSelect, onClose, anchorEl }: CompletionOwnerMenuProps) {
	const t = useT();
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

	useLayoutEffect(() => {
		if (!menuRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const menu = menuRef.current.getBoundingClientRect();
		const pad = 8;
		let top = anchor.bottom + 4;
		let left = anchor.left;
		if (top + menu.height > window.innerHeight - pad) top = anchor.top - menu.height - 4;
		if (left + menu.width > window.innerWidth - pad) left = window.innerWidth - menu.width - pad;
		setPos({ top: Math.max(pad, top), left: Math.max(pad, left) });
		setVisible(true);
		menuRef.current.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
	}, [anchorEl]);

	const anchorRef = useRef<HTMLElement | null>(anchorEl);
	anchorRef.current = anchorEl;
	useOverlayLayer(menuRef, { onDismiss: onClose, triggerRef: anchorRef });

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) onClose();
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [anchorEl, onClose]);

	function handleKeyDown(e: React.KeyboardEvent, index: number) {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const step = e.key === "ArrowDown" ? 1 : OWNERS.length - 1;
		rowRefs.current[(index + step) % OWNERS.length]?.focus();
	}

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			aria-label={t("task.completionOwnerMenu")}
			className="fixed z-[9999] bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active overflow-hidden py-1 max-w-[calc(100vw-1rem)]"
			style={{ top: pos.top, left: pos.left, width: 280, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			{OWNERS.map(({ owner, label, detail }, index) => {
				const isOn = owner === selected;
				return (
					<button
						key={owner}
						ref={(el) => { rowRefs.current[index] = el; }}
						type="button"
						role="menuitemradio"
						aria-checked={isOn}
						onClick={() => onSelect(owner)}
						onKeyDown={(e) => handleKeyDown(e, index)}
						className={`w-full text-left px-3 py-2 transition-colors outline-none hover:bg-overlay-hover focus:bg-overlay-hover ${isOn ? "bg-accent/15" : ""}`}
					>
						<span className="block text-sm font-medium text-fg">{t(label)}</span>
						<span className={`block text-micro leading-snug ${owner === "agent" ? "text-warning-strong" : "text-fg-3"}`}>{t(detail)}</span>
					</button>
				);
			})}
		</div>,
		document.body,
	);
}

export default CompletionOwnerMenu;
