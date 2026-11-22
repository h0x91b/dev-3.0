import { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useT, type TranslationKey } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useViewportClamp } from "../../hooks/useViewportClamp";
import { useHiddenControls } from "../../hooks/useIsControlHidden";
import { restoreControl, showAllControls } from "../../hidden-controls";
import type { TaskHeaderItemId } from "../../hideable-controls";
import { getTaskHeaderRegistry, TASK_HEADER_REGIONS, type TaskHeaderRegion } from "../../task-header/registry";
import Tooltip from "../Tooltip";
import { EyeIcon } from "../TaskIcons";

const BAR_LABEL_KEY: Record<TaskHeaderRegion, TranslationKey> = {
	status: "infoPanel.barContext",
	session: "infoPanel.barSessionAgent",
	git: "infoPanel.barGit",
	runtime: "infoPanel.barRuntime",
};

/** A hidden task-header item, under the bar it belongs to (a group's items under the group's bar). */
export interface HiddenHeaderItem {
	id: TaskHeaderItemId;
	bar: TaskHeaderRegion;
	label: TranslationKey;
}

/** Every hidden item the registry knows, grouped by bar in the header's order. */
export function useHiddenHeaderItems(): [TaskHeaderRegion, HiddenHeaderItem[]][] {
	const hidden = useHiddenControls();
	const registry = getTaskHeaderRegistry();
	// Subscribed, so a hidden extension item that loads later is listed.
	useSyncExternalStore(registry.subscribe, () => registry.list());
	const groups = new Map<TaskHeaderRegion, HiddenHeaderItem[]>(TASK_HEADER_REGIONS.map((bar) => [bar, []]));
	for (const id of hidden) {
		const def = registry.get(id)?.def;
		if (!def) continue;
		const bar = def.region.split(".")[0] as TaskHeaderRegion;
		groups.get(bar)?.push({ id: id as TaskHeaderItemId, bar, label: def.label });
	}
	return [...groups.entries()].filter(([, rows]) => rows.length > 0);
}

export function barLabelKey(bar: TaskHeaderRegion): TranslationKey {
	return BAR_LABEL_KEY[bar];
}

/**
 * The task header's ONE restore control (PRODUCT_UX_BIBLE.md §5.10 / §5.1 chrome): every
 * hidden header item, grouped by bar. Lives in panel chrome next to the worktree-settings
 * gear and the collapse toggle — never inside a bar, and never more than one per panel.
 * A row runs the item's action where it has a single one (`actions`), else restores it;
 * the trailing icon always restores.
 *
 * Portaled to `document.body` with a fixed position (same pattern as
 * `DevServerMenu`/`StatusMenuPortal`), not an in-tree `absolute` child: the
 * panel sits directly above the task terminal, whose own compositing layer
 * can paint over an in-tree dropdown that would otherwise extend past the
 * panel's own box.
 */
export default function PanelRestoreControl({ actions }: { actions: Partial<Record<TaskHeaderItemId, () => void>> }) {
	const t = useT();
	const groups = useHiddenHeaderItems();
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [anchorPos, setAnchorPos] = useState({ top: 0, left: 0 });
	const { position: menuPos, visible } = useViewportClamp(menuRef, anchorPos);
	useEscapeKey(() => setOpen(false), { enabled: open });

	if (groups.length === 0) return null;

	function toggleOpen() {
		if (!open && btnRef.current) {
			const rect = btnRef.current.getBoundingClientRect();
			setAnchorPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 224) });
		}
		setOpen((o) => !o);
	}

	return (
		<>
			<Tooltip content={t("infoPanel.restoreHidden")}>
				<button
					ref={btnRef}
					type="button"
					onClick={toggleOpen}
					aria-label={t("infoPanel.restoreHidden")}
					aria-haspopup="menu"
					aria-expanded={open}
					className="task-anim flex flex-shrink-0 items-center justify-center w-7 h-7 rounded-lg text-fg-3 hover:text-fg hover:bg-elevated-hover transition-colors"
				>
					<EyeIcon off className="w-[1.05rem] h-[1.05rem]" />
				</button>
			</Tooltip>
			{open && createPortal(
				<>
					<div className="fixed inset-0 z-[200]" onClick={() => setOpen(false)} />
					<div
						ref={menuRef}
						role="menu"
						className="fixed z-[201] w-56 max-h-[70vh] overflow-y-auto rounded-xl border border-edge bg-overlay py-1 shadow-2xl"
						style={{ top: menuPos.top, left: menuPos.left, visibility: visible ? "visible" : "hidden" }}
					>
						{groups.map(([bar, rows]) => (
							<div key={bar} role="group" aria-label={t(BAR_LABEL_KEY[bar])}>
								<div className="px-3 pt-2 pb-1 text-micro font-semibold uppercase tracking-wider text-fg-muted" aria-hidden="true">
									{t(BAR_LABEL_KEY[bar])}
								</div>
								{rows.map((row) => {
									const label = t(row.label);
									return (
										<div key={row.id} className="group flex items-center">
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													(actions[row.id] ?? (() => void restoreControl(row.id)))();
													setOpen(false);
												}}
												className="flex-1 min-w-0 text-left px-3 py-1.5 [@media(pointer:coarse)]:min-h-[44px] text-xs text-fg-2 hover:bg-overlay-hover hover:text-fg transition-colors truncate"
											>
												{label}
											</button>
											<button
												type="button"
												onClick={() => restoreControl(row.id)}
												aria-label={t("infoPanel.restoreOne", { name: label })}
												className="mr-1 flex-shrink-0 p-1 rounded text-fg-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 hover:text-fg hover:bg-fg/10 transition-opacity"
											>
												<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
													<path d="M3 12a9 9 0 1 0 3-6.7" />
													<path d="M3 4v5h5" />
												</svg>
											</button>
										</div>
									);
								})}
							</div>
						))}
						<div className="my-1 border-t border-edge" />
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								showAllControls();
								setOpen(false);
							}}
							className="w-full text-left px-3 py-1.5 [@media(pointer:coarse)]:min-h-[44px] text-xs text-accent hover:bg-elevated transition-colors"
						>
							{t("infoPanel.showAllHidden")}
						</button>
					</div>
				</>,
				document.body,
			)}
		</>
	);
}
