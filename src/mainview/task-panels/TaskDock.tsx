import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { useOverlayLayer } from "../utils/useOverlayLayer";
import { OverflowDotsIcon } from "../components/HeaderIcons";
import type { SlotEntry } from "../plugins/slot-registry";
import { activateTaskPanel, closeTaskPanel, setTaskDockSeat, useTaskDock } from "./dock-store";
import { getTaskPanelsRegistry, type TaskPanelDef } from "./registry";

const DEFAULT_WIDTH = 560;
const MIN_WIDTH = 360;
const MAX_RATIO = 0.8;
/** Predates the dock (it was the artifact panel's), kept so nobody's width resets. */
const WIDTH_KEY = "dev3-artifact-panel-width";
/** Bible §9: the dock shows four tabs, the rest wait in "More". */
export const MAX_VISIBLE_TABS = 4;

interface ResizeSession {
	pointerId: number;
	startX: number;
	startWidth: number;
	lastWidth: number;
	target: HTMLDivElement;
	previousCursor: string;
	previousUserSelect: string;
	rafId: number | null;
}

function initialWidth(): number {
	try {
		const value = Number(localStorage.getItem(WIDTH_KEY));
		if (Number.isFinite(value) && value >= MIN_WIDTH) return value;
	} catch { /* ignore */ }
	return DEFAULT_WIDTH;
}

/** Four tabs in opening order; an active tab past the fourth takes the last visible spot. */
export function splitDockTabs<T extends { def: { id: string } }>(tabs: readonly T[], active: string | null): { visible: T[]; more: T[] } {
	if (tabs.length <= MAX_VISIBLE_TABS) return { visible: [...tabs], more: [] };
	const visible = tabs.slice(0, MAX_VISIBLE_TABS);
	const activeIndex = tabs.findIndex((tab) => tab.def.id === active);
	if (activeIndex >= MAX_VISIBLE_TABS) visible[MAX_VISIBLE_TABS - 1] = tabs[activeIndex];
	const shown = new Set(visible);
	return { visible, more: tabs.filter((tab) => !shown.has(tab)) };
}

interface TaskDockProps {
	taskId: string;
	/** The inline diff covers the workspace: no seat at all, open panels wait offscreen. */
	covered: boolean;
	/** Room for a side panel (not narrow, not immersive). Without it the task sits with no dock. */
	canDock: boolean;
}

/**
 * The task workspace's right-hand dock: a drag/keyboard-resizable column with a
 * tab strip (shown from two open panels) over one body element. It renders no
 * panel itself: it publishes the body as the task's seat, and `TaskPanelInstances`
 * moves the open panels into it.
 */
export default function TaskDock({ taskId, covered, canDock }: TaskDockProps) {
	const t = useT();
	const dock = useTaskDock(taskId);
	const registry = getTaskPanelsRegistry();
	const entries = useSyncExternalStore(registry.subscribe, registry.list);
	const tabs = dock.open.map((id) => entries.find((entry) => entry.def.id === id)).filter((entry): entry is SlotEntry<TaskPanelDef> => !!entry);
	const show = !covered && canDock && tabs.length > 0;

	const [owner] = useState(() => ({}));
	const [body, setBody] = useState<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		setTaskDockSeat(taskId, owner, covered ? undefined : show ? body : null);
	}, [taskId, owner, covered, show, body]);
	useLayoutEffect(() => () => setTaskDockSeat(taskId, owner, undefined), [taskId, owner]);

	const [width, setWidth] = useState(initialWidth);
	const [resizing, setResizing] = useState(false);
	const columnRef = useRef<HTMLDivElement>(null);
	const ghostRef = useRef<HTMLDivElement>(null);
	const sessionRef = useRef<ResizeSession | null>(null);

	useEffect(() => {
		try { localStorage.setItem(WIDTH_KEY, String(Math.round(width))); } catch { /* ignore */ }
	}, [width]);

	const clampWidth = useCallback((next: number) => {
		const total = columnRef.current?.parentElement?.clientWidth || window.innerWidth;
		return Math.min(total * MAX_RATIO, Math.max(MIN_WIDTH, next));
	}, []);

	const finishResize = useCallback((releaseCapture: boolean) => {
		const session = sessionRef.current;
		if (!session) return;
		sessionRef.current = null;
		if (session.rafId !== null) cancelAnimationFrame(session.rafId);
		setWidth(session.lastWidth);
		setResizing(false);
		document.body.style.cursor = session.previousCursor;
		document.body.style.userSelect = session.previousUserSelect;
		if (releaseCapture && session.target.hasPointerCapture(session.pointerId)) {
			session.target.releasePointerCapture(session.pointerId);
		}
	}, []);

	const onResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const startWidth = columnRef.current?.offsetWidth || width;
		event.currentTarget.setPointerCapture(event.pointerId);
		sessionRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startWidth,
			lastWidth: startWidth,
			target: event.currentTarget,
			previousCursor: document.body.style.cursor,
			previousUserSelect: document.body.style.userSelect,
			rafId: null,
		};
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		setResizing(true);
	}, [width]);

	// Resizing live would relayout the panel (an artifact iframe) and refit the
	// terminal (SIGWINCH → full TUI repaint) on every pointer move. Only a ghost
	// line follows the pointer; the real width lands once, on pointer up.
	const onResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const session = sessionRef.current;
		if (!session || session.pointerId !== event.pointerId) return;
		session.lastWidth = clampWidth(session.startWidth - (event.clientX - session.startX));
		if (session.rafId !== null) return;
		session.rafId = requestAnimationFrame(() => {
			session.rafId = null;
			if (ghostRef.current) ghostRef.current.style.right = `${session.lastWidth}px`;
		});
	}, [clampWidth]);

	useEffect(() => {
		if (!resizing) return;
		const finishForPointer = (event: PointerEvent) => {
			if (sessionRef.current?.pointerId !== event.pointerId) return;
			finishResize(true);
		};
		const finishForBlur = () => finishResize(true);
		const finishWhenHidden = () => {
			if (document.visibilityState === "hidden") finishResize(true);
		};
		window.addEventListener("pointerup", finishForPointer, true);
		window.addEventListener("pointercancel", finishForPointer, true);
		window.addEventListener("blur", finishForBlur);
		document.addEventListener("visibilitychange", finishWhenHidden);
		return () => {
			window.removeEventListener("pointerup", finishForPointer, true);
			window.removeEventListener("pointercancel", finishForPointer, true);
			window.removeEventListener("blur", finishForBlur);
			document.removeEventListener("visibilitychange", finishWhenHidden);
		};
	}, [resizing, finishResize]);

	useEffect(() => () => {
		const session = sessionRef.current;
		if (!session) return;
		if (session.rafId !== null) cancelAnimationFrame(session.rafId);
		document.body.style.cursor = session.previousCursor;
		document.body.style.userSelect = session.previousUserSelect;
	}, []);

	useEffect(() => {
		if (!show) return;
		const container = columnRef.current?.parentElement;
		const clamp = () => {
			const total = container?.clientWidth || window.innerWidth;
			setWidth((current) => Math.min(total * MAX_RATIO, Math.max(MIN_WIDTH, current)));
		};
		clamp();
		window.addEventListener("resize", clamp);
		let observer: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined" && container) {
			observer = new ResizeObserver(clamp);
			observer.observe(container);
		}
		return () => {
			window.removeEventListener("resize", clamp);
			observer?.disconnect();
		};
	}, [show]);

	if (!show) return null;
	return (
		<>
			{resizing && (
				<div data-testid="task-dock-resize-shield" aria-hidden="true" className="absolute inset-0 z-[60] cursor-col-resize">
					<div ref={ghostRef} className="absolute top-0 bottom-0 w-[2px] bg-accent" style={{ right: width }} />
				</div>
			)}
			<div
				className={`group flex w-[7px] flex-shrink-0 touch-none cursor-col-resize items-center justify-center transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none ${resizing ? "bg-accent/15" : ""}`}
				onPointerDown={onResizeStart}
				onPointerMove={onResizeMove}
				onPointerUp={() => finishResize(true)}
				onPointerCancel={() => finishResize(true)}
				onLostPointerCapture={() => finishResize(false)}
				onDoubleClick={() => setWidth(clampWidth(DEFAULT_WIDTH))}
				onKeyDown={(event) => {
					if (event.key === "ArrowLeft") { event.preventDefault(); setWidth((current) => clampWidth(current + 24)); }
					else if (event.key === "ArrowRight") { event.preventDefault(); setWidth((current) => clampWidth(current - 24)); }
				}}
				role="separator"
				tabIndex={0}
				aria-orientation="vertical"
				aria-label={t("taskDock.resize")}
				aria-valuemin={MIN_WIDTH}
				aria-valuemax={Math.round((columnRef.current?.parentElement?.clientWidth || window.innerWidth) * MAX_RATIO)}
				aria-valuenow={Math.round(width)}
			>
				<div className={`h-8 w-[3px] rounded-full transition-colors group-hover:bg-accent group-focus-visible:bg-accent ${resizing ? "bg-accent" : "bg-fg-muted/60"}`} />
			</div>
			<div
				ref={columnRef}
				data-testid="task-dock"
				className="min-h-0 min-w-0 flex-shrink-0 overflow-hidden flex flex-col"
				style={{ width }}
			>
				{tabs.length > 1 && <DockTabs taskId={taskId} tabs={tabs} active={dock.active} />}
				<div ref={setBody} data-testid="task-dock-body" className="min-h-0 flex-1 flex flex-col" />
			</div>
		</>
	);
}

function DockTabs({ taskId, tabs, active }: { taskId: string; tabs: readonly SlotEntry<TaskPanelDef>[]; active: string | null }) {
	const t = useT();
	const { visible, more } = splitDockTabs(tabs, active);
	const stripRef = useRef<HTMLDivElement>(null);
	function onKeyDown(event: React.KeyboardEvent) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		const buttons = Array.from(stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (current < 0) return;
		event.preventDefault();
		const next = buttons[(current + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
		next.focus();
		next.click();
	}
	return (
		<div className="flex flex-shrink-0 items-center gap-0.5 border-b border-edge bg-raised px-1.5 py-1">
			<div ref={stripRef} role="tablist" aria-label={t("taskDock.tabs")} onKeyDown={onKeyDown} className="flex min-w-0 flex-1 items-center gap-0.5">
				{visible.map((tab) => {
					const selected = tab.def.id === active;
					const title = tab.def.title(t);
					return (
						<div
							key={tab.def.id}
							className={`group/tab flex min-w-0 items-center rounded-md transition-colors ${selected ? "bg-elevated text-fg" : "text-fg-3 hover:bg-raised-hover hover:text-fg"}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={selected}
								tabIndex={selected ? 0 : -1}
								onClick={() => activateTaskPanel(taskId, tab.def.id)}
								className="min-w-0 truncate px-2.5 py-1 text-xs font-medium"
							>
								{title}
							</button>
							{tab.def.closable !== false && (
								<button
									type="button"
									onClick={() => closeTaskPanel(taskId, tab.def.id)}
									aria-label={t("taskDock.closeTab", { title })}
									title={t("taskDock.closeTab", { title })}
									className="mr-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-fg-muted hover:bg-overlay-hover hover:text-fg"
								>
									<span aria-hidden="true" className="text-sm leading-none">×</span>
								</button>
							)}
						</div>
					);
				})}
			</div>
			{more.length > 0 && <MoreTabs taskId={taskId} tabs={more} />}
		</div>
	);
}

function MoreTabs({ taskId, tabs }: { taskId: string; tabs: readonly SlotEntry<TaskPanelDef>[] }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	return (
		<div className="relative flex-shrink-0">
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-label={t("slots.more")}
				title={t("slots.more")}
				aria-haspopup="menu"
				aria-expanded={open}
				className={`flex items-center rounded-md px-1.5 py-1 transition-colors ${open ? "bg-elevated text-fg" : "text-fg-3 hover:bg-raised-hover hover:text-fg"}`}
			>
				<OverflowDotsIcon className="h-4 w-4" />
			</button>
			{open && <MoreMenu taskId={taskId} tabs={tabs} triggerRef={triggerRef} onDismiss={() => setOpen(false)} />}
		</div>
	);
}

function MoreMenu({ taskId, tabs, triggerRef, onDismiss }: {
	taskId: string;
	tabs: readonly SlotEntry<TaskPanelDef>[];
	triggerRef: React.RefObject<HTMLButtonElement | null>;
	onDismiss: () => void;
}) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	useOverlayLayer(menuRef, { onDismiss, triggerRef, autoFocus: true });
	useEffect(() => {
		function onMouseDown(event: MouseEvent) {
			const target = event.target as Node;
			if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
			onDismiss();
		}
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [onDismiss, triggerRef]);
	function onKeyDown(event: React.KeyboardEvent) {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
		const current = items.indexOf(document.activeElement as HTMLElement);
		event.preventDefault();
		items[(current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
	}
	return (
		<div ref={menuRef} role="menu" onKeyDown={onKeyDown} className="absolute right-0 top-full z-50 mt-1 min-w-44 rounded-xl border border-edge bg-overlay py-1 shadow-2xl">
			{tabs.map((tab) => (
				<button
					key={tab.def.id}
					type="button"
					role="menuitem"
					onClick={() => {
						activateTaskPanel(taskId, tab.def.id);
						onDismiss();
						triggerRef.current?.focus();
					}}
					className="block w-full truncate px-3 py-1.5 text-left text-sm text-fg-2 hover:bg-overlay-hover hover:text-fg"
				>
					{tab.def.title(t)}
				</button>
			))}
		</div>
	);
}
