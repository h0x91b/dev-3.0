import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TaskStatus, TmuxWindowEntry } from "../../shared/types";
import { useT, type TFunction } from "../i18n";
import { useTmuxWindows } from "../hooks/useTmuxWindows";
import { requestTaskTerminalFocus } from "../terminal-focus-request";
import { closeTmuxWindow, openTmuxWindow, renameTmuxWindow } from "../terminal-window-nav";
import { WINDOW_NAME_MAX } from "../../shared/window-name";
import { toast } from "../toast";
import Tooltip from "./Tooltip";

/**
 * Desktop navigator for a task's tmux WINDOWS (full-terminal workspaces inside
 * the task's one session; panes are the splits inside a window): a tab row above
 * the terminal, always shown so the place never moves. It lists every window,
 * which one you are in, the agent's home window (✦, always first), and which
 * background windows printed something since you last looked. The terminal child
 * keeps its tree position, so the row appearing never remounts the terminal.
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
	const { windows, unseen, arrived, navigate } = useTmuxWindows(taskId, enabled);
	const visible = windows.length > 0;

	const select = (w: TmuxWindowEntry) => {
		// The first click of a double-click switches; its late focus must not steal the rename field.
		void navigate({ windowId: w.windowId }).then(() => {
			if (!document.activeElement?.closest("[data-window-rename]")) requestTaskTerminalFocus(taskId);
		});
	};
	const rename = (w: TmuxWindowEntry, name: string) => {
		void renameTmuxWindow(taskId, w.windowId, name).catch((err) => toast.error(t("panes.actionFailed", { error: String(err) }), { taskId }));
	};
	const close = (w: TmuxWindowEntry) => {
		// tmux never closes a session's last window; offering it would be a dead control.
		if (windows.length < 2) return;
		void closeTmuxWindow(taskId, w.windowId, t).catch((err) => toast.error(t("panes.actionFailed", { error: String(err) }), { taskId }));
	};

	return (
		<div className="flex-1 min-h-0 min-w-0 flex flex-col">
			{visible && (
				<WindowTabs
					windows={windows}
					unseen={unseen}
					agentWorking={taskStatus === "in-progress"}
					agentWaiting={taskStatus === "user-questions"}
					onSelect={select}
					onClose={close}
					onRename={rename}
					onNew={() => void openTmuxWindow(taskId).then(() => requestTaskTerminalFocus(taskId))}
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

/** The name a user gave the window wins; else the home window carries the task's title — the same order the tmux bar uses. */
export function windowName(w: TmuxWindowEntry, t: TFunction, homeTitle?: string): string {
	return w.customName || automaticWindowName(w, t, homeTitle);
}

/** What the window is called when nobody named it — what clearing a rename brings back. */
function automaticWindowName(w: TmuxWindowEntry, t: TFunction, homeTitle?: string): string {
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

function WindowTabs({
	windows,
	unseen,
	agentWorking,
	agentWaiting,
	onSelect,
	onClose,
	onRename,
	onNew,
	homeTitle,
	t,
}: {
	windows: TmuxWindowEntry[];
	unseen: ReadonlySet<string>;
	agentWorking: boolean;
	agentWaiting: boolean;
	onSelect: (w: TmuxWindowEntry) => void;
	onClose: (w: TmuxWindowEntry) => void;
	onRename: (w: TmuxWindowEntry, name: string) => void;
	onNew: () => void;
	homeTitle?: string;
	t: TFunction;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const [menu, setMenu] = useState<WindowMenuState | null>(null);
	const [editing, setEditing] = useState<{ windowId: string; width: number } | null>(null);
	// A lone window cannot be closed, so it gets no ×.
	const closable = windows.length > 1;
	const activeId = windows.find((w) => w.active)?.windowId;

	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
		el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [activeId]);

	const tabOf = (windowId: string) => listRef.current?.querySelector<HTMLElement>(`[role="tab"][data-window-id="${windowId}"]`) ?? null;

	// The field takes the tab's own width (never narrower than a short name), so the row does not jump.
	const startRename = (w: TmuxWindowEntry) => {
		const width = tabOf(w.windowId)?.getBoundingClientRect().width ?? 0;
		setEditing({ windowId: w.windowId, width });
	};
	const finishRename = (w: TmuxWindowEntry, name: string | null) => {
		setEditing(null);
		if (name !== null) onRename(w, name);
		requestAnimationFrame(() => tabOf(w.windowId)?.focus());
	};

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
				setMenu({ window: target, x: r.left, y: r.bottom, opener: tabs[at] });
			}
			return;
		}
		if (e.key === "F2") {
			const target = windows.find((w) => w.windowId === tabs[at].dataset.windowId);
			if (target) {
				e.preventDefault();
				startRename(target);
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
		let to = -1;
		if (e.key === "ArrowRight") to = (at + 1) % tabs.length;
		else if (e.key === "ArrowLeft") to = (at - 1 + tabs.length) % tabs.length;
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
		<div data-window-nav="" className="flex-shrink-0 flex items-center gap-1 px-2 py-1 overflow-x-auto overflow-y-hidden bg-raised border-b border-edge window-nav-scroll">
		<div
			ref={listRef}
			role="tablist"
			aria-label={t("windowPager.role")}
			aria-orientation="horizontal"
			onKeyDown={onKeyDown}
			className="flex items-center gap-1"
		>
			{windows.map((w) => {
				const isUnseen = unseen.has(w.windowId);
				const name = windowName(w, t, homeTitle);
				const state = windowStateText(w, isUnseen, t, agentWorking, agentWaiting);
				const accessibleName = state ? `${name}, ${state}` : name;
				if (editing?.windowId === w.windowId) {
					return (
						<WindowRenameField
							key={w.windowId}
							window={w}
							width={editing.width}
							automaticName={automaticWindowName(w, t, homeTitle)}
							onDone={(value) => finishRename(w, value)}
							t={t}
						/>
					);
				}
				return (
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
							onDoubleClick={() => startRename(w)}
							onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
							onAuxClick={(e) => { if (e.button === 1) onClose(w); }}
							onContextMenu={openMenu(w)}
							className={`relative flex-shrink-0 h-6 max-w-[14rem] min-w-0 pl-2 ${closable ? "pr-6" : "pr-2"} rounded-lg flex items-center gap-1.5 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
								w.active ? "bg-accent/15 text-fg shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.3)]" : "text-fg-3 hover:text-fg-2 hover:bg-elevated"
							}`}
						>
							{/* The leading glyph steps aside for the rename pencil, which takes its slot — the tab never changes width. */}
							<span aria-hidden="true" className="flex-shrink-0 transition-opacity duration-150 ease-out group-hover:opacity-0 group-focus-within:opacity-0">
								{w.home ? <HomeGlyph working={agentWorking} /> : <span className={`tabular-nums ${w.active ? "text-accent" : "text-fg-muted"}`}>{w.index}</span>}
							</span>
							<span aria-hidden="true" className="truncate">{name}</span>
							<WindowMarker window={w} unseen={isUnseen} />
						</button>
					</Tooltip>
						{/* Keyboard users rename with F2 and close with Delete on the focused tab; these are the pointer paths. */}
						<button
							type="button"
							tabIndex={-1}
							aria-label={t("windowNav.rename", { name })}
							title={t("windowNav.rename", { name })}
							data-window-rename-button={w.windowId}
							onClick={() => startRename(w)}
							className={`absolute left-1 top-1/2 -translate-y-1/2 w-4 h-4 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-[opacity,background-color,color,scale] duration-150 ease-out active:scale-[0.96] ${
								w.active ? "text-accent hover:bg-accent/20" : "text-fg-muted hover:text-fg hover:bg-elevated-hover"
							}`}
						>
							<svg aria-hidden="true" viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"><path d="M7.6 2.4l2 2M2.5 9.5l.5-2.2 5.3-5.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4L5 9.3z" /></svg>
						</button>
						{closable && <button
							type="button"
							tabIndex={-1}
							aria-label={t("windowNav.close", { name })}
							title={t("windowNav.close", { name })}
							data-window-close={w.windowId}
							onClick={() => onClose(w)}
							className={`absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 rounded-md flex items-center justify-center transition-[opacity,background-color,color,scale] duration-150 ease-out active:scale-[0.96] ${
								w.active ? "opacity-100 text-accent hover:bg-accent/20" : "opacity-0 group-hover:opacity-100 text-fg-muted hover:text-fg hover:bg-elevated-hover"
							}`}
						>
							<svg aria-hidden="true" viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
						</button>}
					</div>
				);
			})}
			{menu && <WindowMenu state={menu} closable={closable} onSelect={onSelect} onClose={onClose} onRename={startRename} onDismiss={() => setMenu(null)} t={t} />}
		</div>
			{/* Right after the last tab, like the tmux bar's own +; it lands on the new window. */}
			<Tooltip content={t("tmux.newWindowDesc")} placement="bottom">
				<button
					type="button"
					aria-label={t("tmux.newWindowDesc")}
					data-window-new=""
					onClick={onNew}
					className="flex-shrink-0 ml-0.5 w-6 h-6 rounded-full border border-edge flex items-center justify-center text-fg-3 hover:text-fg hover:bg-elevated hover:border-edge-active transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
				>
					<svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><path d="M6 2.5v7M2.5 6h7" /></svg>
				</button>
			</Tooltip>
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

/** Right-click (or ⇧F10) menu on a window: switch to it, rename it, or close it. */
function WindowMenu({
	state,
	closable,
	onSelect,
	onClose,
	onRename,
	onDismiss,
	t,
}: {
	state: WindowMenuState;
	closable: boolean;
	onSelect: (w: TmuxWindowEntry) => void;
	onClose: (w: TmuxWindowEntry) => void;
	onRename: (w: TmuxWindowEntry) => void;
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
					<button type="button" role="menuitem" onClick={() => run(() => onSelect(w))} className={`${item} text-fg-2 hover:bg-overlay-hover hover:text-fg focus:bg-overlay-hover focus:text-fg`}>
						{t("windowNav.switchTo")}
					</button>
				)}
				<button type="button" role="menuitem" onClick={() => run(() => onRename(w))} className={`${item} text-fg-2 hover:bg-overlay-hover hover:text-fg focus:bg-overlay-hover focus:text-fg`}>
					{t("windowNav.renameItem")}
				</button>
				{closable && (
					<button type="button" role="menuitem" onClick={() => run(() => onClose(w))} className={`${item} text-danger hover:bg-danger/10 focus:bg-danger/10`}>
						{t("tmux.closeWindowDesc")}
					</button>
				)}
			</div>
		</>,
		document.body,
	);
}

/**
 * The tab turned into its own name field. Enter or leaving the field keeps the
 * text, Esc drops it; an empty field hands the window back to automatic naming,
 * which the placeholder shows.
 */
function WindowRenameField({
	window: w,
	width,
	automaticName,
	onDone,
	t,
}: {
	window: TmuxWindowEntry;
	width: number;
	automaticName: string;
	onDone: (name: string | null) => void;
	t: TFunction;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const doneRef = useRef(false);
	const finish = (name: string | null) => {
		if (doneRef.current) return;
		doneRef.current = true;
		// Confirming the name it already had must not pin an automatic name in place.
		onDone(name !== null && name.trim() === (w.customName ?? automaticName) ? null : name);
	};

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	return (
		<div data-window-rename={w.windowId} className="flex-shrink-0 flex" style={{ width: Math.max(width, 128) }}>
			<input
				ref={inputRef}
				type="text"
				defaultValue={w.customName ?? automaticName}
				placeholder={automaticName}
				maxLength={WINDOW_NAME_MAX}
				aria-label={t("windowNav.renameField")}
				spellCheck={false}
				autoComplete="off"
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						finish(e.currentTarget.value);
					} else if (e.key === "Escape") {
						e.preventDefault();
						finish(null);
					}
				}}
				onBlur={(e) => finish(e.currentTarget.value)}
				className="w-full h-6 px-2 rounded-lg bg-base text-fg text-xs font-medium placeholder:text-fg-muted"
			/>
		</div>
	);
}

function HomeGlyph({ working }: { working: boolean }) {
	return (
		<span aria-hidden="true" className={`leading-none ${working ? "motion-safe:animate-pulse" : ""}`}>
			✦
		</span>
	);
}

/** Background signal after the name: bell (warning) outranks new output (accent). */
function WindowMarker({ window: w, unseen }: { window: TmuxWindowEntry; unseen: boolean }) {
	if (w.active || (!w.bell && !unseen)) return null;
	return (
		<span
			aria-hidden="true"
			data-window-marker={w.bell ? "bell" : "output"}
			className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${w.bell ? "bg-warning" : "bg-accent"}`}
		/>
	);
}
