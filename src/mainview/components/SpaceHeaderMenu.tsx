import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../hooks/useEscapeKey";
import type { Space } from "../../shared/types";
import { useT } from "../i18n";

/** Nerd Font nf-md-dots_horizontal — the menu anchor's glyph. Exported so a row
 *  without a menu can donate exactly its width and keep the numbers in column. */
export const SPACE_MENU_GLYPH = "\u{F01D9}";

interface SpaceHeaderMenuProps {
	space: Space;
	onRename: (space: Space, name: string) => void;
	onDelete: (space: Space) => void;
	/** Omitted when there is only one space — nothing to move it past. */
	onMove?: (space: Space, delta: -1 | 1) => void;
	canMoveUp?: boolean;
	canMoveDown?: boolean;
	/** Opens the membership editor. Omitted where the surface shows its own
	 *  `Edit` control beside the name, so the menu does not repeat it. */
	onEditProjects?: (space: Space) => void;
	/** Prefixes every test id — two surfaces render this menu at once. */
	scope?: string;
}

/**
 * The space's own actions — order, rename, delete. Membership stays on the
 * header's `+` and the row's Spaces… action. This is the space object's chrome,
 * not a task row's (§10).
 *
 * Move up / down live here because the rail reorders by drag, which touch and
 * the keyboard cannot perform. An overflow entry costs no resting pixels; a
 * second visible control in a 224px rail did.
 */
function SpaceHeaderMenu({
	space,
	onRename,
	onDelete,
	onMove,
	canMoveUp,
	canMoveDown,
	onEditProjects,
	scope = "space",
}: SpaceHeaderMenuProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(space.name);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const anchorRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	function close() {
		setOpen(false);
		setRenaming(false);
		setDraft(space.name);
	}

	useEscapeKey(() => {
		if (open) close();
	});

	useLayoutEffect(() => {
		if (!open || !anchorRef.current || !menuRef.current) return;
		const anchor = anchorRef.current.getBoundingClientRect();
		const menu = menuRef.current.getBoundingClientRect();
		const pad = 8;
		let top = anchor.bottom + 4;
		let left = anchor.right - menu.width;
		if (top + menu.height > window.innerHeight - pad) top = anchor.top - menu.height - 4;
		if (left < pad) left = pad;
		setPos({ top, left });
	}, [open, renaming]);

	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				!anchorRef.current?.contains(e.target as Node)
			) {
				close();
			}
		}
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	useEffect(() => {
		if (renaming) inputRef.current?.select();
	}, [renaming]);

	function commitRename() {
		const name = draft.trim();
		if (name && name !== space.name) onRename(space, name);
		close();
	}

	const itemClass =
		"w-full text-left px-3 py-2 text-xs transition-colors hover:bg-elevated-hover";

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="menu"
				aria-expanded={open}
				className="p-1 rounded text-fg-3 hover:text-fg hover:bg-elevated transition-colors"
				title={t("spaces.menuLabel")}
				aria-label={t("spaces.menuLabel")}
				data-testid={`${scope}-menu-${space.id}`}
			>
				<span aria-hidden="true" className="text-base leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
					{SPACE_MENU_GLYPH}
				</span>
			</button>
			{open &&
				createPortal(
					<div
						ref={menuRef}
						role="menu"
						className="fixed z-50 w-52 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active overflow-hidden py-1"
						style={{ top: pos.top, left: pos.left }}
					>
						{renaming ? (
							<div className="p-2">
								<input
									ref={inputRef}
									type="text"
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											commitRename();
										}
									}}
									className="w-full bg-elevated border border-edge rounded-lg px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent/50 transition-colors"
									data-testid={`${scope}-rename-input-${space.id}`}
								/>
								<button
									type="button"
									onClick={commitRename}
									disabled={!draft.trim()}
									className="mt-2 w-full px-2.5 py-1.5 rounded-lg bg-accent text-white text-xs hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
									data-testid={`${scope}-rename-save-${space.id}`}
								>
									{t("spaces.renameSave")}
								</button>
							</div>
						) : (
							<>
								{onEditProjects && (
									<button
										type="button"
										role="menuitem"
										onClick={() => {
											close();
											onEditProjects(space);
										}}
										className={`${itemClass} text-fg-2 hover:text-fg`}
										data-testid={`${scope}-edit-projects-${space.id}`}
									>
										{t("spaces.editProjectsMenu")}
									</button>
								)}
								{onMove && (
									<>
										<button
											type="button"
											role="menuitem"
											onClick={() => {
												close();
												onMove(space, -1);
											}}
											disabled={!canMoveUp}
											className={`${itemClass} text-fg-2 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent`}
											data-testid={`${scope}-move-up-${space.id}`}
										>
											{t("spaces.moveUp")}
										</button>
										<button
											type="button"
											role="menuitem"
											onClick={() => {
												close();
												onMove(space, 1);
											}}
											disabled={!canMoveDown}
											className={`${itemClass} text-fg-2 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent`}
											data-testid={`${scope}-move-down-${space.id}`}
										>
											{t("spaces.moveDown")}
										</button>
									</>
								)}
								<button
									type="button"
									role="menuitem"
									onClick={() => setRenaming(true)}
									className={`${itemClass} text-fg-2 hover:text-fg`}
									data-testid={`${scope}-rename-${space.id}`}
								>
									{t("spaces.rename")}
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										close();
										onDelete(space);
									}}
									className={`${itemClass} text-danger`}
									data-testid={`${scope}-delete-${space.id}`}
								>
									{t("spaces.delete")}
								</button>
							</>
						)}
					</div>,
					document.body,
				)}
		</>
	);
}

export default SpaceHeaderMenu;
