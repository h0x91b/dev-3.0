import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import type { FavoriteChip } from "../utils/agentPicker";

interface FavoritesMenuProps {
	/** Ordered, resolved favorite chips (may be empty — the Save row still shows). */
	chips: FavoriteChip[];
	/** Current picker selection, so the matching row reads as active. */
	activeAgentId: string | null;
	activeConfigId: string | null;
	/** Whether the current combo is itself a favorite (drives the top toggle row). */
	currentIsFavorite: boolean;
	/** Whether the current selection can be saved (a provider + mode are chosen). */
	canSaveCurrent: boolean;
	/** Add/remove the CURRENT combo (the top toggle row). Keeps the menu open. */
	onToggleCurrent: () => void;
	/** Apply a favorite to THIS picker (resolved configId). */
	onApply: (agentId: string, configId: string) => void;
	/** Remove a favorite from storage (original stored configId). */
	onRemove: (agentId: string, storedConfigId: string) => void;
	onClose: () => void;
	anchorEl: HTMLElement;
}

/** Nerd Font star — filled (favorited) / outline (not). Crisp + theme-colored,
 *  unlike the thin unicode ☆ (see decision 125). Shared by the menu's Save row
 *  and the picker's column trigger so the glyph/escape logic lives in one place. */
export function StarGlyph({ filled, className = "" }: { filled: boolean; className?: string }) {
	return (
		<span
			aria-hidden
			style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			className={`leading-none ${className}`}
		>
			{filled ? "\uf005" : "\uf006"}
		</span>
	);
}

/**
 * Anchored popover for one launch picker's favorites: a top Save/Remove toggle
 * for the CURRENT combo, then the list of saved combos (apply on click, × to
 * remove). Portal-rendered (never clipped by a variant card), viewport-clamped,
 * left-aligned to the trigger; closes on click-outside (Escape is staged by the
 * parent picker so it dismisses this menu before the modal). Per-picker, so the
 * global favorites list is never duplicated across variant rows (decision 125).
 */
function FavoritesMenu({
	chips,
	activeAgentId,
	activeConfigId,
	currentIsFavorite,
	canSaveCurrent,
	onToggleCurrent,
	onApply,
	onRemove,
	onClose,
	anchorEl,
}: FavoritesMenuProps) {
	const t = useT();
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (!menuRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const menu = menuRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = anchor.bottom + 4;
		// Left-align to the anchor: the trigger sits at the left of the picker row.
		let left = anchor.left;
		if (top + menu.height > vh - pad) top = anchor.top - menu.height - 4;
		if (left + menu.width > vw - pad) left = vw - menu.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
	}, [anchorEl, chips.length]);

	// Escape is owned by the parent AgentConfigPicker (it must close this menu
	// *before* the surrounding launch modal); this popover only closes on
	// click-outside / selecting a row / re-clicking the trigger.
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				!anchorEl.contains(e.target as Node)
			) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [anchorEl, onClose]);

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			aria-label={t("launch.favorites")}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active overflow-hidden py-1 max-w-[calc(100vw-1rem)]"
			style={{ top: pos.top, left: pos.left, width: 360, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			{/* Save/Remove the CURRENT combo (mirrors the trigger star). Keeps the
			    menu open so the user sees the row appear/disappear in the list. */}
			<button
				type="button"
				role="menuitem"
				disabled={!canSaveCurrent}
				onClick={onToggleCurrent}
				title={currentIsFavorite ? t("launch.removeThisCombo") : t("launch.saveThisCombo")}
				className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs outline-none transition-colors disabled:opacity-40 disabled:cursor-default ${
					currentIsFavorite ? "text-favorite hover:bg-elevated-hover" : "text-fg-2 hover:bg-elevated-hover hover:text-fg"
				}`}
			>
				<StarGlyph filled={currentIsFavorite} className="text-sm flex-shrink-0" />
				<span className="flex-1 truncate">
					{currentIsFavorite ? t("launch.removeThisCombo") : t("launch.saveThisCombo")}
				</span>
			</button>

			{chips.length > 0 && <div className="my-1 border-t border-edge" />}

			{chips.map((chip) => {
				const isOn = chip.agentId === activeAgentId && chip.configId === activeConfigId;
				return (
					<div
						key={`${chip.agentId} ${chip.storedConfigId}`}
						className={`group flex items-center transition-colors ${isOn ? "bg-elevated" : "hover:bg-elevated-hover"}`}
					>
						<button
							type="button"
							role="menuitemradio"
							aria-checked={isOn}
							onClick={() => onApply(chip.agentId, chip.configId)}
							className="flex-1 min-w-0 text-left pl-3 pr-2 py-1.5 flex items-center gap-2 outline-none focus:bg-elevated-hover"
							title={chip.label}
						>
							<span className={`flex-1 truncate text-xs ${isOn ? "text-accent" : "text-fg-2 group-hover:text-fg"}`}>
								{chip.label}
							</span>
							{isOn && (
								<svg className="w-3.5 h-3.5 flex-shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
								</svg>
							)}
						</button>
						<button
							type="button"
							aria-label={t("launch.removeFavorite")}
							title={t("launch.removeFavorite")}
							onClick={() => onRemove(chip.agentId, chip.storedConfigId)}
							className="flex-shrink-0 px-2 py-1.5 text-sm leading-none text-fg-muted hover:text-danger outline-none"
						>
							×
						</button>
					</div>
				);
			})}
		</div>,
		document.body,
	);
}

export default FavoritesMenu;
