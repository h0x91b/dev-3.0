import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Select, { type SelectOption } from "../components/Select";
import { useT, type TranslationKey } from "../i18n";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { CordisContext } from "../plugins/react";
import type { RegisteredBoardView } from "./registry";

/** Built-ins label themselves with an i18n key; an extension's label is plain text. */
export function useViewLabel(): (view: RegisteredBoardView) => string {
	const t = useT();
	return (view) => (view.def.id.startsWith("builtin:") ? t(view.def.label as TranslationKey) : view.def.label);
}

const MANAGE_VIEWS = "__manage-views__";
const SAVE_VIEW = "__save-view__";
const UPDATE_VIEW = "__update-view__";
const REVERT_VIEW = "__revert-view__";
const RENAME_VIEW = "__rename-view__";
const DELETE_VIEW = "__delete-view__";
const NAMED_PREFIX = "named:";

/** What the switcher needs to list named saved views and act on the applied one. */
export interface SavedViewsSwitcherProps {
	named: readonly { id: string; name: string }[];
	/** The named view the board shows, if any. */
	appliedId: string | null;
	modified: boolean;
	onApply: (id: string) => void;
	onSave: () => void;
	onUpdate: (id: string) => void;
	onRevert: (id: string) => void;
	onRename: (id: string) => void;
	onDelete: (id: string) => void;
}

/**
 * "Kanban ▾" at the left end of the filter row (D13): named saved views, then the
 * view types, then the actions, ending in "Manage views…". The host decides whether it shows at all.
 */
export function BoardViewSwitcher({ views, activeId, onPick, onManage, saved }: {
	views: readonly RegisteredBoardView[];
	activeId: string;
	onPick: (id: string) => void;
	onManage: () => void;
	saved: SavedViewsSwitcherProps;
}) {
	const t = useT();
	const labelOf = useViewLabel();
	const applied = saved.appliedId ? saved.named.find((view) => view.id === saved.appliedId) ?? null : null;
	const grouped = saved.named.length > 0;
	const actions: SelectOption[] = [];
	if (applied && saved.modified) {
		actions.push({ value: UPDATE_VIEW, label: t("boardView.saved.update", { name: applied.name }) });
		actions.push({ value: REVERT_VIEW, label: t("boardView.saved.revert") });
	}
	if (applied) {
		actions.push({ value: RENAME_VIEW, label: t("boardView.saved.rename", { name: applied.name }) });
		actions.push({ value: DELETE_VIEW, label: t("boardView.saved.delete", { name: applied.name }) });
	}
	actions.push({ value: SAVE_VIEW, label: t("boardView.saved.save") });
	actions[0] = { ...actions[0], divider: true };

	const options: SelectOption[] = [
		...saved.named.map((view) => ({
			value: `${NAMED_PREFIX}${view.id}`,
			label: view.id === applied?.id && saved.modified ? t("boardView.saved.modifiedName", { name: view.name }) : view.name,
			section: t("boardView.saved.section"),
		})),
		...views.map((view) => ({ value: view.def.id, label: labelOf(view), ...(grouped ? { section: t("boardView.saved.viewsSection") } : {}) })),
		...actions,
		{ value: MANAGE_VIEWS, label: t("boardView.manage") },
	];

	function choose(value: string) {
		if (value.startsWith(NAMED_PREFIX)) return saved.onApply(value.slice(NAMED_PREFIX.length));
		switch (value) {
			case MANAGE_VIEWS: return onManage();
			case SAVE_VIEW: return saved.onSave();
			case UPDATE_VIEW: return applied && saved.onUpdate(applied.id);
			case REVERT_VIEW: return applied && saved.onRevert(applied.id);
			case RENAME_VIEW: return applied && saved.onRename(applied.id);
			case DELETE_VIEW: return applied && saved.onDelete(applied.id);
			default: return onPick(value);
		}
	}

	return (
		<div className="flex-shrink-0" data-testid="board-view-switcher">
			<Select
				value={applied ? `${NAMED_PREFIX}${applied.id}` : activeId}
				options={options}
				onChange={choose}
				ariaLabel={t("boardView.switcherAria")}
				renderOption={(option) => (option.value === MANAGE_VIEWS ? <ManageViewsOption label={option.label} /> : option.label)}
				growList
			/>
		</div>
	);
}

/** An action, not a view: the gear keeps it from reading as one more board layout. */
function ManageViewsOption({ label }: { label: string }) {
	return (
		<span className="flex items-center gap-2">
			<svg aria-hidden className="w-3.5 h-3.5 flex-shrink-0 text-fg-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
			</svg>
			{label}
		</span>
	);
}

/** The ghost "View options" icon; the popover's content belongs to the active view. */
export function BoardViewOptionsButton({ view }: { view: RegisteredBoardView }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const Options = view.def.Options;
	if (!Options) return null;
	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen((prev) => !prev)}
				aria-label={t("boardView.optionsAria")}
				title={t("boardView.optionsAria")}
				aria-expanded={open}
				data-testid="board-view-options"
				className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-raised-hover transition-[color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
			>
				<svg aria-hidden className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
					<path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
					<circle cx="16" cy="7" r="2" />
					<circle cx="10" cy="17" r="2" />
				</svg>
			</button>
			{open && triggerRef.current && (
				<OptionsPopover anchor={triggerRef.current} triggerRef={triggerRef} onDismiss={() => setOpen(false)}>
					<CordisContext.Provider value={view.ctx}>
						<Options ctx={view.ctx} />
					</CordisContext.Provider>
				</OptionsPopover>
			)}
		</>
	);
}

function OptionsPopover({ anchor, triggerRef, onDismiss, children }: {
	anchor: HTMLElement;
	triggerRef: React.RefObject<HTMLButtonElement | null>;
	onDismiss: () => void;
	children: ReactNode;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, right: 0 });
	useLayoutEffect(() => {
		const rect = anchor.getBoundingClientRect();
		setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
	}, [anchor]);
	useOverlayLayer(panelRef, { onDismiss, triggerRef, autoFocus: true });
	useEffect(() => {
		function onMouseDown(e: MouseEvent) {
			const target = e.target as Node;
			if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
			onDismiss();
		}
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [onDismiss, triggerRef]);
	return createPortal(
		<div
			ref={panelRef}
			role="dialog"
			style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}
			className="bg-overlay border border-edge rounded-xl shadow-xl p-3 min-w-56 max-w-[min(24rem,92vw)]"
		>
			{children}
		</div>,
		document.body,
	);
}
