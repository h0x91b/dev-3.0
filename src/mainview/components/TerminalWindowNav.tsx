import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { TaskStatus, TmuxWindowEntry } from "../../shared/types";
import { useT, type TFunction } from "../i18n";
import { useTmuxWindows } from "../hooks/useTmuxWindows";
import { requestTaskTerminalFocus } from "../terminal-focus-request";
import { useWindowNavStyle, type WindowNavStyle } from "../terminal-window-nav";
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
	homeTitle,
	t,
}: {
	style: WindowNavStyle;
	windows: TmuxWindowEntry[];
	unseen: ReadonlySet<string>;
	agentWorking: boolean;
	agentWaiting: boolean;
	onSelect: (w: TmuxWindowEntry) => void;
	homeTitle?: string;
	t: TFunction;
}) {
	const listRef = useRef<HTMLDivElement>(null);
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
				const marker = <WindowMarker window={w} unseen={isUnseen} />;
				return rail ? (
					<Tooltip key={w.windowId} content={name} detail={state || undefined} placement="right">
						<button
							type="button"
							role="tab"
							aria-selected={w.active}
							aria-label={accessibleName}
							tabIndex={w.active ? 0 : -1}
							onClick={() => onSelect(w)}
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
				) : (
					<Tooltip key={w.windowId} content={name} detail={state || undefined} placement="bottom">
						<button
							type="button"
							role="tab"
							aria-selected={w.active}
							aria-label={accessibleName}
							tabIndex={w.active ? 0 : -1}
							onClick={() => onSelect(w)}
							className={`relative flex-shrink-0 h-7 max-w-[14rem] min-w-0 px-2.5 rounded-t-md flex items-center gap-1.5 text-dense transition-[background-color,color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
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
				);
			})}
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

/** Background signal, top-right: bell (warning) outranks new output (accent). */
function WindowMarker({ window: w, unseen }: { window: TmuxWindowEntry; unseen: boolean }) {
	if (w.active || (!w.bell && !unseen)) return null;
	return (
		<span
			aria-hidden="true"
			data-window-marker={w.bell ? "bell" : "output"}
			className={`absolute top-0 right-0 w-1.5 h-1.5 rounded-full ${w.bell ? "bg-warning" : "bg-accent"}`}
		/>
	);
}
