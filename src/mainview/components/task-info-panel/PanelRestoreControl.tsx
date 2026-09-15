import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT, type TranslationKey } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useViewportClamp } from "../../hooks/useViewportClamp";
import { useHiddenControls } from "../../hooks/useIsControlHidden";
import { restoreControl, showAllControls } from "../../hidden-controls";
import { PANEL_BAR_OF_CONTROL, type HideableControlId } from "../../hideable-controls";
import Tooltip from "../Tooltip";
import { EyeIcon } from "../TaskIcons";

export type PanelHideableEntry = {
	id: HideableControlId;
	label: string;
	onRun: () => void;
};

const BAR_LABEL_KEY: Record<string, TranslationKey> = {
	context: "infoPanel.barContext",
	"session-agent": "infoPanel.barSessionAgent",
	runtime: "infoPanel.barRuntime",
};

/**
 * The task info panel's ONE restore control (PRODUCT_UX_BIBLE.md §5.10 / §5.1
 * chrome). Lives in panel chrome next to the worktree-settings gear and the
 * collapse toggle — never inside a bar, and never more than one per panel.
 *
 * Portaled to `document.body` with a fixed position (same pattern as
 * `DevServerMenu`/`StatusMenuPortal`), not an in-tree `absolute` child: the
 * panel sits directly above the task terminal, whose own compositing layer
 * can paint over an in-tree dropdown that would otherwise extend past the
 * panel's own box.
 */
export default function PanelRestoreControl({ entries }: { entries: PanelHideableEntry[] }) {
	const t = useT();
	const hidden = useHiddenControls();
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [anchorPos, setAnchorPos] = useState({ top: 0, left: 0 });
	const { position: menuPos, visible } = useViewportClamp(menuRef, anchorPos);
	useEscapeKey(() => setOpen(false), { enabled: open });

	const visibleEntries = entries.filter((entry) => hidden.has(entry.id));
	if (visibleEntries.length === 0) return null;

	const groups = new Map<string, PanelHideableEntry[]>();
	for (const entry of visibleEntries) {
		const bar = PANEL_BAR_OF_CONTROL[entry.id] ?? "context";
		const rows = groups.get(bar) ?? [];
		rows.push(entry);
		groups.set(bar, rows);
	}

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
					className="flex flex-shrink-0 items-center justify-center w-7 h-7 rounded-lg text-fg-3 hover:text-fg hover:bg-elevated-hover transition-colors"
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
						{[...groups.entries()].map(([bar, rows]) => (
							<div key={bar}>
								<div className="px-3 pt-2 pb-1 text-micro font-semibold uppercase tracking-wider text-fg-muted">
									{t(BAR_LABEL_KEY[bar] ?? "infoPanel.barContext")}
								</div>
								{rows.map((entry) => (
									<div key={entry.id} className="group flex items-center">
										<button
											type="button"
											role="menuitem"
											onClick={() => {
												entry.onRun();
												setOpen(false);
											}}
											className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-fg-2 hover:bg-elevated hover:text-fg transition-colors truncate"
										>
											{entry.label}
										</button>
										<button
											type="button"
											onClick={() => restoreControl(entry.id)}
											aria-label={t("infoPanel.restoreOne", { name: entry.label })}
											className="mr-1 flex-shrink-0 p-1 rounded text-fg-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-fg hover:bg-elevated-hover transition-opacity"
										>
											<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
												<path d="M3 12a9 9 0 1 0 3-6.7" />
												<path d="M3 4v5h5" />
											</svg>
										</button>
									</div>
								))}
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
							className="w-full text-left px-3 py-1.5 text-xs text-accent hover:bg-elevated transition-colors"
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
