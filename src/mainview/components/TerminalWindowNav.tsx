import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TaskStatus, TmuxWindowEntry } from "../../shared/types";
import { useT, type TFunction } from "../i18n";
import { useTmuxWindows } from "../hooks/useTmuxWindows";
import { requestTaskTerminalFocus } from "../terminal-focus-request";
import { closeTmuxWindow, useWindowNavStyle, type WindowNavStyle } from "../terminal-window-nav";
import { toast } from "../toast";
import Tooltip from "./Tooltip";

/**
 * Desktop navigator for a task's tmux WINDOWS (full-terminal workspaces inside
 * the task's one session; panes are the splits inside a window). Invisible with
 * a single window. With two or more it shows every window, which one you are
 * in, the agent's home window (✦, always first), and which background windows
 * printed something since you last looked. Rail (left) or tabs (top) per the
 * Appearance setting. The terminal child keeps its tree position across every
 * state, so showing or restyling the navigator never remounts the terminal.
 */
export default function TerminalWindowNav({
	taskId,
	taskStatus,
	taskTitle,
	enabled = true,
	children,
}: {
	taskId: string;
	taskStatus?: TaskStatus;
	taskTitle?: string;
	/** False while the terminal has no session yet — nothing to list, no polling. */
	enabled?: boolean;
	children: ReactNode;
}) {
	const t = useT();
	const style = useWindowNavStyle();
	const { windows, unseen, arrived, navigate } = useTmuxWindows(taskId, enabled);
	const visible = windows.length > 1;

	const select = (w: TmuxWindowEntry) => {
		void navigate({ windowId: w.windowId }).then(() => requestTaskTerminalFocus(taskId));
	};
	const close = (w: TmuxWindowEntry) => {
		void closeTmuxWindow(taskId, w.windowId, t).catch((err) => toast.error(t("panes.actionFailed", { error: String(err) }), { taskId }));
	};

	return (
		<div className={`flex-1 min-h-0 min-w-0 flex ${style === "rail" ? "flex-row" : "flex-col"}`}>
			{visible && (
				<WindowList
					style={style}
					windows={windows}
					unseen={unseen}
					agentWorking={taskStatus === "in-progress"}
					agentWaiting={taskStatus === "user-questions"}
					onSelect={select}
					onClose={close}
					homeTitle={taskTitle}
					t={t}
				/>
			)}
			<div className="relative flex-1 min-h-0 min-w-0 flex flex-col">{children}</div>
			<div role="status" aria-live="polite" className="sr-only">
				{visible && arrived ? t("windowNav.arrived", { name: windowName(arrived, t, taskTitle) }) : ""}
			</div>
		</div>
	);
}

/** The agent's home window carries the task's title — the same name the tmux bar shows. */
export function windowName(w: TmuxWindowEntry, t: TFunction, homeTitle?: string): string {
	return (w.home && homeTitle) || w.label || t("windowPager.window", { index: String(w.index) });
}

function windowStateText(w: TmuxWindowEntry, unseen: boolean, t: TFunction, agentWorking: boolean, agentWaiting: boolean): string {
	const parts: string[] = [];
	if (w.home) parts.push(agentWorking ? t("windowNav.homeWorking") : agentWaiting ? t("windowNav.homeWaiting") : t("windowNav.home"));
	if (w.bell) parts.push(t("windowNav.bell"));
	else if (unseen) parts.push(t("windowNav.newOutput"));
	if (w.panes > 1) parts.push(t.plural("windowNav.panes", w.panes));
	return parts.join(" · ");
}

function WindowList({
	style,
	windows,
	unseen,
	agentWorking,
	agentWaiting,
	onSelect,
	onClose,
	homeTitle,
	t,
}: {
	style: WindowNavStyle;
	windows: TmuxWindowEntry[];
	unseen: ReadonlySet<string>;
	agentWorking: boolean;
	agentWaiting: boolean;
	onSelect: (w: TmuxWindowEntry) => void;
	onClose: (w: TmuxWindowEntry) => void;
	homeTitle?: string;
	t: TFunction;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const [menu, setMenu] = useState<WindowMenuState | null>(null);
	const rail = style === "rail";
	const activeId = windows.find((w) => w.active)?.windowId;

	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
		el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [activeId, style]);

	// Roving focus: arrows move between windows, Enter/Space switches (manual
	// activation — switching repaints the whole terminal, so focus alone must not).
	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		const tabs = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
		const at = tabs.indexOf(document.activeElement as HTMLElement);
		if (at < 0) return;
		if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
			const target = windows.find((w) => w.windowId === tabs[at].dataset.windowId);
			if (target) {
				e.preventDefault();
				const r = tabs[at].getBoundingClientRect();
				setMenu({ window: target, x: rail ? r.right : r.left, y: rail ? r.top : r.bottom, opener: tabs[at] });
			}
			return;
		}
		if (e.key === "Delete" || e.key === "Backspace") {
			const target = windows.find((w) => w.windowId === tabs[at].dataset.windowId);
			if (target) {
				e.preventDefault();
				onClose(target);
			}
			return;
		}
		const prev = rail ? "ArrowUp" : "ArrowLeft";
		const next = rail ? "ArrowDown" : "ArrowRight";
		let to = -1;
		if (e.key === next) to = (at + 1) % tabs.length;
		else if (e.key === prev) to = (at - 1 + tabs.length) % tabs.length;
		else if (e.key === "Home") to = 0;
		else if (e.key === "End") to = tabs.length - 1;
		if (to < 0) return;
		e.preventDefault();
		tabs[to].focus();
	}

	const openMenu = (w: TmuxWindowEntry) => (e: MouseEvent<HTMLButtonElement>) => {
		e.preventDefault();
		setMenu({ window: w, x: e.clientX, y: e.clientY, opener: e.currentTarget });
	};

	return (
		<div
			ref={listRef}
			role="tablist"
			aria-label={t("windowPager.role")}
			aria-orientation={rail ? "vertical" : "horizontal"}
			onKeyDown={onKeyDown}
			data-window-nav={style}
			className={
				rail
					? "flex-shrink-0 w-7 flex flex-col items-center gap-0.5 py-1 overflow-y-auto overflow-x-hidden bg-raised border-r border-edge window-nav-scroll"
					: "flex-shrink-0 flex items-end gap-0.5 px-1.5 pt-1 overflow-x-auto overflow-y-hidden bg-raised border-b border-edge window-nav-scroll"
			}
		>
			{windows.map((w) => {
				const isUnseen = unseen.has(w.windowId);
				const name = windowName(w, t, homeTitle);
				const state = windowStateText(w, isUnseen, t, agentWorking, agentWaiting);
				const accessibleName = state ? `${name}, ${state}` : name;
				const marker = <WindowMarker window={w} unseen={isUnseen} inline={!rail} />;
				return rail ? (
					<div key={w.windowId} role="presentation" className="group relative flex-shrink-0 flex">
					<Tooltip content={name} detail={state || undefined} placement="right">
						<button
							type="button"
							role="tab"
							aria-selected={w.active}
							aria-label={accessibleName}
							tabIndex={w.active ? 0 : -1}
							data-window-id={w.windowId}
							onClick={() => onSelect(w)}
							onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
							onAuxClick={(e) => { if (e.button === 1) onClose(w); }}
							onContextMenu={openMenu(w)}
							className={`relative flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-micro font-semibold tabular-nums transition-[background-color,color,box-shadow] duration-150 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
								w.active
									? "bg-base text-fg shadow-[0_0_0_2px_rgb(var(--accent))]"
									: "text-fg-3 hover:text-fg hover:bg-elevated shadow-[0_0_0_1px_rgb(var(--border-default))]"
							}`}
						>
							{w.home ? <HomeGlyph working={agentWorking} /> : <span aria-hidden="true">{w.index}</span>}
							{marker}
						</button>
					</Tooltip>
						{/* Overlays the tile's corner on hover, so closing costs the rail no width. */}
						<button
							type="button"
							tabIndex={-1}
							aria-label={t("windowNav.close", { name })}
							data-window-close={w.windowId}
							onClick={() => onClose(w)}
							className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center bg-overlay text-fg-2 hover:text-fg hover:bg-danger/80 shadow-[0_0_0_1px_rgb(var(--border-default)),0_1px_2px_rgb(0_0_0/0.3)] opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-150"
						>
							<span aria-hidden="true" className="text-[10px] leading-none">×</span>
						</button>
					</div>
				) : (
					<div key={w.windowId} role="presentation" className="group relative flex-shrink-0 flex">
					<Tooltip content={name} detail={state || undefined} placement="bottom">
						<button
							type="button"
							role="tab"
							aria-selected={w.active}
							aria-label={accessibleName}
							tabIndex={w.active ? 0 : -1}
							data-window-id={w.windowId}
							onClick={() => onSelect(w)}
							onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
							onAuxClick={(e) => { if (e.button === 1) onClose(w); }}
							onContextMenu={openMenu(w)}
							className={`relative flex-shrink-0 h-7 max-w-[14rem] min-w-0 pl-2.5 pr-7 rounded-t-md flex items-center gap-1.5 text-dense transition-[background-color,color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
								w.active
									? "bg-base text-fg shadow-[inset_0_2px_0_rgb(var(--accent))]"
									: "text-fg-3 hover:text-fg hover:bg-elevated"
							}`}
						>
							{w.home ? <HomeGlyph working={agentWorking} /> : <span aria-hidden="true" className="text-fg-muted tabular-nums">{w.index}</span>}
							<span aria-hidden="true" className="truncate">{name}</span>
							{marker}
						</button>
					</Tooltip>
						{/* Keyboard users close with Delete on the focused tab; this is the pointer path. */}
						<button
							type="button"
							tabIndex={-1}
							aria-label={t("windowNav.close", { name })}
							title={t("windowNav.close", { name })}
							data-window-close={w.windowId}
							onClick={() => onClose(w)}
							className={`absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-fg-muted hover:text-fg hover:bg-elevated transition-opacity duration-150 ${
								w.active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
							}`}
						>
							<span aria-hidden="true" className="text-sm leading-none">×</span>
						</button>
					</div>
				);
			})}
			{menu && <WindowMenu state={menu} onSelect={onSelect} onClose={onClose} onDismiss={() => setMenu(null)} t={t} />}
		</div>
	);
}

interface WindowMenuState {
	window: TmuxWindowEntry;
	x: number;
	y: number;
	/** Focus returns here when the menu is dismissed. */
	opener: HTMLElement;
}

/** Right-click (or ⇧F10) menu on a window — the rail's discoverable way to close one. */
function WindowMenu({
	state,
	onSelect,
	onClose,
	onDismiss,
	t,
}: {
	state: WindowMenuState;
	onSelect: (w: TmuxWindowEntry) => void;
	onClose: (w: TmuxWindowEntry) => void;
	onDismiss: () => void;
	t: TFunction;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const w = state.window;

	useEffect(() => {
		menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}, []);

	const dismiss = (restoreFocus: boolean) => {
		onDismiss();
		if (restoreFocus) state.opener.focus();
	};
	const run = (action: () => void) => {
		dismiss(false);
		action();
	};

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		if (e.key === "Escape" || e.key === "Tab") {
			e.preventDefault();
			dismiss(true);
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			items[(at + step + items.length) % items.length]?.focus();
		}
	}

	const item = "w-full text-left px-3 py-1.5 text-xs transition-colors focus-visible:outline-none";
	return createPortal(
		<>
			<div
				className="fixed inset-0 z-[200]"
				onClick={() => dismiss(false)}
				onContextMenu={(e) => {
					e.preventDefault();
					dismiss(false);
				}}
			/>
			<div
				ref={menuRef}
				role="menu"
				aria-label={windowName(w, t)}
				onKeyDown={onKeyDown}
				className="fixed z-[201] min-w-[10rem] rounded-lg border border-edge bg-overlay py-1 shadow-2xl"
				style={{ top: state.y, left: state.x }}
			>
				{!w.active && (
					<button type="button" role="menuitem" onClick={() => run(() => onSelect(w))} className={`${item} text-fg-2 hover:bg-elevated hover:text-fg focus:bg-elevated focus:text-fg`}>
						{t("windowNav.switchTo")}
					</button>
				)}
				<button type="button" role="menuitem" onClick={() => run(() => onClose(w))} className={`${item} text-danger hover:bg-danger/10 focus:bg-danger/10`}>
					{t("tmux.closeWindowDesc")}
				</button>
			</div>
		</>,
		document.body,
	);
}

function HomeGlyph({ working }: { working: boolean }) {
	return (
		<span aria-hidden="true" className={`leading-none ${working ? "motion-safe:animate-pulse" : ""}`}>
			✦
		</span>
	);
}

/** Background signal, top-right: bell (warning) outranks new output (accent). */
function WindowMarker({ window: w, unseen, inline }: { window: TmuxWindowEntry; unseen: boolean; inline: boolean }) {
	if (w.active || (!w.bell && !unseen)) return null;
	return (
		<span
			aria-hidden="true"
			data-window-marker={w.bell ? "bell" : "output"}
			className={`${inline ? "flex-shrink-0" : "absolute top-0 right-0"} w-1.5 h-1.5 rounded-full ${w.bell ? "bg-warning" : "bg-accent"}`}
		/>
	);
}
