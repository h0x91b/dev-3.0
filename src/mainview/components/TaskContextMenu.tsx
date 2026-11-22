import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Project, Task } from "../../shared/types";
import type { AppAction } from "../state";
import { useT } from "../i18n";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { registerOverlayLayer } from "../utils/overlay-layers";
import { computeMenuFlyoutPosition, MENU_FLYOUT_HOVER_MS } from "../utils/menuFlyout";
import { getTaskMenuRegistry, TASK_MENU_GROUPS, type TaskMenuItem, type TaskMenuScope } from "../task-menu/registry";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import { groupMenuRows, runMenuItem, type MenuRow } from "../plugins/menu-rows";
import BottomSheet from "./BottomSheet";
import TaskDetailModal from "./TaskDetailModal";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

interface TaskContextMenuProps {
	task: Task;
	/** The task's OWN project — labels, columns and the move source resolve against it. */
	project: Project;
	dispatch: Dispatch<AppAction>;
	/** Cursor position the menu opens at; null keeps it closed. */
	pos: { x: number; y: number } | null;
	onClose: () => void;
	/** Opens the task's workspace — the row/card's own navigation. */
	onOpenTask: () => void;
	/** Surfaces that already own a detail modal pass theirs; otherwise one is rendered here. */
	onOpenDetails?: () => void;
	/** Filters the board to the task's lineage batch; the row is shown only when given. */
	onShowFamily?: () => void;
	testId?: string;
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * Right-click actions for one task, shared by the Kanban card, the Active Tasks
 * sidebar row and every board view. The rows are the `taskMenu` slot's items;
 * this host only lays them out and owns the menu's own state.
 */
export default function TaskContextMenu({
	onShowFamily,
	task,
	project,
	dispatch,
	pos,
	onClose,
	onOpenTask,
	onOpenDetails,
	testId,
}: TaskContextMenuProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const registry = getTaskMenuRegistry();
	/** The item whose phone surface the sheet handed off to, if any. */
	const [sheet, setSheet] = useState<string | null>(null);
	// Every card and sidebar row keeps a closed menu mounted: only an open one listens to the slot.
	const entries = useSyncExternalStore(pos || sheet ? registry.subscribe : NO_SUBSCRIPTION, registry.list);
	const [flyout, setFlyout] = useState<string | null>(null);
	// A flyout opened from the keyboard takes focus; one opened by hover leaves it be.
	const [flyoutByKey, setFlyoutByKey] = useState(false);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => () => clearHoverTimer(), []);

	// Cards keep this component mounted between openings, so a closed menu must
	// not leave its flyout (or a pending hover swap) behind for the next one.
	useEffect(() => {
		if (pos) return;
		clearHoverTimer();
		setFlyout(null);
		setFlyoutByKey(false);
	}, [pos]);

	function clearHoverTimer() {
		if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
		hoverTimer.current = null;
	}

	/**
	 * Entering a row decides the open flyout after a dwell, so a pointer crossing
	 * other rows on its way into a tall flyout does not swap it. Entering the open
	 * flyout counts as entering its own row and cancels a pending swap.
	 */
	function hoverRow(id: string | null) {
		clearHoverTimer();
		hoverTimer.current = setTimeout(() => {
			hoverTimer.current = null;
			setFlyoutByKey(false);
			setFlyout(id);
		}, MENU_FLYOUT_HOVER_MS);
	}

	function openFlyoutNow(id: string, byKey: boolean) {
		clearHoverTimer();
		setFlyoutByKey(byKey);
		setFlyout(id);
	}
	// Pickers anchor to an element, so the cursor point becomes a 0×0 one.
	const [anchorPos, setAnchorPos] = useState({ x: 0, y: 0 });
	const [anchorEl, setAnchorEl] = useState<HTMLDivElement | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [autoRename, setAutoRename] = useState(false);

	function openSheet(id: string) {
		if (pos) setAnchorPos(pos);
		setAnchorEl(null);
		setSheet(id);
		onClose();
	}

	function closeSheet() {
		setSheet(null);
		setAnchorEl(null);
	}

	/** Ends a pick made from either the phone surface or a desktop flyout. */
	function finishPick() {
		closeSheet();
		setFlyout(null);
		onClose();
	}

	const scope: TaskMenuScope = {
		task,
		project,
		dispatch,
		t,
		openTask: onOpenTask,
		openDetails(rename) {
			setAutoRename(rename);
			if (onOpenDetails && !rename) {
				onOpenDetails();
				return;
			}
			setDetailOpen(true);
		},
		showFamily: onShowFamily,
	};
	const pick = { done: finishPick, close: closeSheet };

	function select(item: TaskMenuItem) {
		if (item.submenu) {
			openSheet(item.id);
			return;
		}
		onClose();
		runMenuItem("taskMenu", item.id, item.run, scope);
	}

	function renderRow(row: MenuRow<TaskMenuItem>) {
		const { item } = row;
		const hasFlyout = !!item.submenu && !narrow;
		const open = hasFlyout && flyout === item.id;
		const button = (
			<button
				key={item.id}
				type="button"
				role="menuitem"
				disabled={row.disabled}
				data-menu-row=""
				data-testid={`task-menu-${row.key}`}
				aria-haspopup={hasFlyout ? "menu" : undefined}
				aria-expanded={hasFlyout ? open : undefined}
				onClick={(e) => {
					e.stopPropagation();
					// Hover has often opened it already; a click must not toggle it shut.
					if (hasFlyout) openFlyoutNow(item.id, false);
					else select(item);
				}}
				onKeyDown={(e) => {
					if (hasFlyout && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						openFlyoutNow(item.id, true);
					}
				}}
				className={`flex w-full items-center gap-2 px-3 text-left transition-colors disabled:opacity-40 disabled:pointer-events-none ${
					narrow ? "py-3 text-sm-plus" : "py-1.5 text-sm"
				} ${
					item.danger
						? "text-danger hover:bg-danger/10"
						: `text-fg-2 hover:bg-overlay-hover hover:text-fg ${open ? "bg-overlay-hover text-fg" : ""}`
				}`}
			>
				<span aria-hidden className="w-3 flex-shrink-0 text-center text-xs leading-none text-accent">
					{row.checked ? "✓" : ""}
				</span>
				<span className="min-w-0 flex-1 truncate">{row.label}</span>
				{item.submenu && (
					<span aria-hidden className="flex-shrink-0 text-xs leading-none text-fg-muted">
						{"▸"}
					</span>
				)}
			</button>
		);
		if (narrow) return button;
		return (
			<div key={item.id} onMouseEnter={() => hoverRow(hasFlyout && !row.disabled ? item.id : null)}>
				{button}
				{open && (
					<Flyout
						width={item.submenu?.width}
						testId={`task-menu-flyout-${row.key}`}
						label={row.label}
						autoFocus={flyoutByKey}
						onBack={(rowEl, refocus) => {
							clearHoverTimer();
							setFlyout(null);
							if (refocus) rowEl.querySelector<HTMLButtonElement>("[data-menu-row]")?.focus();
						}}
					>
						{item.submenu && <GuardedSubmenu id={item.id} render={() => item.submenu!.flyout(scope, pick)} />}
					</Flyout>
				)}
			</div>
		);
	}

	// Rows are resolved only while the menu is open: a long-lived card must not run every item each render.
	const rows: ReactNode[] = [];
	if (pos) {
		groupMenuRows("taskMenu", entries, scope, TASK_MENU_GROUPS).forEach((group, groupIndex) => {
			if (groupIndex > 0) rows.push(<div key={`sep-${groupIndex}`} className="my-1 border-t border-edge" />);
			for (const row of group) rows.push(renderRow(row));
		});
	}

	const menu = pos ? (
		narrow ? (
			<div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
				<BottomSheet open onClose={onClose} title={t("taskMenu.title")} testId={testId}>
					<div role="menu">{rows}</div>
				</BottomSheet>
			</div>
		) : (
			<MenuPanel pos={pos} label={t("taskMenu.title")} testId={testId} onClose={onClose}>
				{rows}
			</MenuPanel>
		)
	) : null;

	const sheetItem = sheet ? registry.get(sheet)?.def : undefined;

	return (
		<>
			{menu}
			{sheet &&
				createPortal(
					<div ref={setAnchorEl} className="fixed h-0 w-0" style={{ top: anchorPos.y, left: anchorPos.x }} />,
					document.body,
				)}
			{sheetItem?.submenu && <GuardedSubmenu id={sheetItem.id} onCrash={closeSheet} render={() => sheetItem.submenu!.sheet(scope, { ...pick, anchorEl, anchorPos })} />}
			{/* Portalled: the sidebar column clips a modal rendered in place. */}
			{detailOpen &&
				createPortal(
					<TaskDetailModal
						task={task}
						project={project}
						dispatch={dispatch}
						autoRename={autoRename}
						onClose={() => {
							setDetailOpen(false);
							setAutoRename(false);
						}}
						onOpenTask={onOpenTask}
					/>,
					document.body,
				)}
		</>
	);
}

/**
 * The desktop panel, mounted only while open: `useOverlayLayer` registers on
 * mount, so a panel that merely appears inside a long-lived component would
 * never reach the Escape/Tab stack.
 */
function MenuPanel({
	pos,
	label,
	testId,
	onClose,
	children,
}: {
	pos: { x: number; y: number };
	label: string;
	testId?: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const [measured, setMeasured] = useState(false);

	useOverlayLayer(panelRef, { onDismiss: onClose });

	// Land on the first row once the panel is visible — a hidden element takes no
	// focus, and until then the arrow keys below have nothing to move from.
	useEffect(() => {
		if (measured) items()[0]?.focus();
	}, [measured]);

	function items(): HTMLButtonElement[] {
		return [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-row]:not([disabled])") ?? [])];
	}

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		// Keys typed inside a flyout (a search field, its own list) are the flyout's.
		if (!(e.target as HTMLElement).hasAttribute?.("data-menu-row")) return;
		e.preventDefault();
		const all = items();
		const at = all.indexOf(document.activeElement as HTMLButtonElement);
		const next = e.key === "ArrowDown" ? at + 1 : at - 1;
		all[(next + all.length) % all.length]?.focus();
	}

	// Render at the cursor first, then flip the panel back inside the window.
	useLayoutEffect(() => {
		const el = panelRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const pad = 8;
		let top = pos.y;
		let left = pos.x;
		if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad);
		if (left + rect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad);
		setMenuPos({ top, left });
		setMeasured(true);
	}, [pos]);

	useEffect(() => {
		function onPointerDown(e: MouseEvent) {
			if (!panelRef.current?.contains(e.target as Node)) onClose();
		}
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [onClose]);

	return createPortal(
		<div
			ref={panelRef}
			role="menu"
			aria-label={label}
			data-testid={testId}
			className="fixed z-[10000] min-w-[13rem] max-w-[18rem] rounded-xl border border-edge-active bg-overlay py-1.5 shadow-2xl shadow-black/40"
			style={measured ? { top: menuPos.top, left: menuPos.left } : { top: pos.y, left: pos.x, visibility: "hidden" }}
			onClick={(e) => e.stopPropagation()}
			onContextMenu={(e) => e.preventDefault()}
			onKeyDown={onKeyDown}
		>
			{children}
		</div>,
		document.body,
	);
}

/** Calls a submenu's render function as a component, so its throw stays inside its own boundary. */
function SubmenuContent({ render }: { render: () => ReactNode }) {
	return <>{render()}</>;
}

/** Runs `onCrash` once the fallback is on screen: never a state update during render. */
function CrashedSubmenu({ onCrash }: { onCrash?: () => void }) {
	useEffect(() => onCrash?.(), [onCrash]);
	return null;
}

/** One item's submenu; a crash leaves it empty (logged) instead of taking the menu and its host down. */
function GuardedSubmenu({ id, render, onCrash }: { id: string; render: () => ReactNode; onCrash?: () => void }) {
	return (
		<SlotErrorBoundary slot="taskMenu" resetKey={id} fallback={() => <CrashedSubmenu onCrash={onCrash} />}>
			<SubmenuContent render={render} />
		</SlotErrorBoundary>
	);
}

/**
 * A submenu panel beside its row, placed by the shared menu-flyout geometry
 * (right of the menu, flipping left near the window edge). It stays inside the
 * menu's DOM, so the menu's click-outside and focus-out treat it as inside.
 */
function Flyout({
	width,
	testId,
	label,
	autoFocus,
	onBack,
	children,
}: {
	width?: number;
	testId: string;
	label: string;
	autoFocus: boolean;
	/** Close the flyout; `refocus` moves focus back to its row. */
	onBack: (rowEl: HTMLElement, refocus: boolean) => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const onBackRef = useRef(onBack);
	onBackRef.current = onBack;

	// An overlay layer of its own, so Escape closes the flyout before the menu.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		return registerOverlayLayer(el, () => {
			if (el.parentElement) onBackRef.current(el.parentElement, el.contains(document.activeElement));
		});
	}, []);

	useLayoutEffect(() => {
		const el = ref.current;
		const row = el?.parentElement;
		if (!el || !row) return;
		const place = () => setPos(computeMenuFlyoutPosition(row, { width: el.offsetWidth, height: el.offsetHeight }, "right"));
		place();
		// The label search and the async project list change the height after mount.
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(place);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Waits for the measured position: a browser ignores focus() inside the hidden first frame.
	const placed = pos !== null;
	useEffect(() => {
		const el = ref.current;
		if (!autoFocus || !placed || !el || el.contains(document.activeElement)) return;
		const start = el.querySelector<HTMLElement>('[aria-checked="true"]') ?? el.querySelector<HTMLElement>("input, button:not([disabled])");
		start?.focus();
	}, [autoFocus, placed]);

	return (
		<div
			ref={ref}
			role="menu"
			aria-label={label}
			data-testid={testId}
			className="fixed z-10 overflow-hidden rounded-xl border border-edge-active bg-overlay shadow-2xl shadow-black/40"
			style={pos ? { top: pos.top, left: pos.left, width } : { top: 0, left: 0, width, visibility: "hidden" }}
			onKeyDown={(e) => {
				if (e.key !== "ArrowLeft" || (e.target as HTMLElement).tagName === "INPUT") return;
				e.preventDefault();
				if (ref.current?.parentElement) onBack(ref.current.parentElement, true);
			}}
		>
			{children}
		</div>
	);
}
