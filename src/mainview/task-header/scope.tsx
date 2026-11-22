import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project, Task } from "../../shared/types";
import { SlotItemPlacementContext, SlotItems, type SlotItemMenuRequest } from "../plugins/SlotItems";
import { useHiddenControls } from "../hooks/useIsControlHidden";
import { regionLayout, useTaskHeaderUserLayout } from "./layout";
import { TaskHeaderItemMenu } from "./item-menu";
import type { TaskBranchStatusController } from "../components/task-info-panel/useTaskBranchStatus";
import type { TaskInlineDiffRequest } from "../components/task-inline-diff";
import type { TaskSessionController } from "./useTaskSession";
import { getTaskHeaderRegistry, TASK_HEADER_BAR_BUDGET, TASK_HEADER_BUDGET_EXCEPTIONS, TASK_HEADER_REGIONS, type TaskHeaderGroup, type TaskHeaderRegion, type TaskHeaderScope } from "./registry";

/** Where a region is drawn: its bar in the header, or its section of the narrow actions sheet. */
export type TaskHeaderSurface = "bar" | "sheet";

/** How much room the header has. Measured once by `<TaskHeader>`, read by every bar. */
export interface TaskHeaderLayout {
	/** Narrow window (`useCompact`): icon-only buttons. */
	compact: boolean;
	/** The header itself is narrow (split view): content folds first. */
	tight: boolean;
	/** The one-row header; the expanded one shows the details grid under it. */
	collapsed: boolean;
	/** Phone-width viewport: one summary bar plus the actions sheet. */
	narrow: boolean;
}

/**
 * Internal state the built-in items share across bars. The branch status has one owner,
 * the header, because the Context bar's diff badge reads it too. Not part of the slot's
 * public scope (decisions/2026/11/21/task-header-git-items.md).
 */
interface TaskHeaderInternals {
	layout: TaskHeaderLayout;
	/** The task's status is one of `ACTIVE_STATUSES`: its worktree and session may be live. */
	isTaskActive: boolean;
	/** The project with the worktree's own `.dev3/` config layered on: scripts and dev servers read it. */
	resolvedProject: Project;
	git: TaskBranchStatusController;
	/** The session bar's dialogs and hibernation; the restore control (chrome) runs them too. */
	session: TaskSessionController;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
	/** Closes the narrow actions sheet; a sheet row that opens something else calls it first. */
	closeSheet: () => void;
	/** The task's variant group, the task included; empty outside a group. */
	variants: Task[];
	/** The fullscreen task screen, where switching variant keeps the screen. */
	isFullPage?: boolean;
}

interface TaskHeaderContextValue extends TaskHeaderInternals {
	scope: TaskHeaderScope;
}

const TaskHeaderContext = createContext<TaskHeaderContextValue | null>(null);
const SurfaceContext = createContext<TaskHeaderSurface>("bar");

/** Scoped to one mounted header, so two headers on screen never see each other's task. */
export function TaskHeaderProvider({ value, children }: { value: TaskHeaderContextValue; children: ReactNode }) {
	return <TaskHeaderContext.Provider value={value}>{children}</TaskHeaderContext.Provider>;
}

function useTaskHeaderContext(): TaskHeaderContextValue {
	const value = useContext(TaskHeaderContext);
	if (!value) throw new Error("A task header item rendered outside <TaskHeader>");
	return value;
}

export function useTaskHeaderScope(): TaskHeaderScope {
	return useTaskHeaderContext().scope;
}

const ROOMY: Pick<TaskHeaderLayout, "compact" | "tight"> = { compact: false, tight: false };

/** In the More menu a bar item has a whole row, so it draws its roomy, labelled form. */
export function useTaskHeaderInternals(): TaskHeaderInternals {
	const value = useTaskHeaderContext();
	const placement = useContext(SlotItemPlacementContext);
	const { layout } = value;
	const roomyLayout = useMemo(() => ({ ...layout, ...ROOMY }), [layout]);
	return placement === "overflow" ? { ...value, layout: roomyLayout } : value;
}

export function useTaskHeaderSurface(): TaskHeaderSurface {
	return useContext(SurfaceContext);
}

function isBar(region: TaskHeaderRegion | TaskHeaderGroup): region is TaskHeaderRegion {
	return (TASK_HEADER_REGIONS as readonly string[]).includes(region);
}

/**
 * Focus goes back where the menu came from. When the menu removed that control (Hide,
 * Move to More, Show in bar), it lands on the first control left in the same bar.
 */
function returnFocusAfterMenu(target: HTMLElement | null): void {
	if (!target) return;
	const bar = target.closest("[data-slot-item]")?.parentElement ?? target.parentElement;
	target.focus();
	requestAnimationFrame(() => {
		if (!target.isConnected) bar?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
	});
}

/**
 * One region's items. `display: contents`, so the items lay out as children of the
 * host's bar box and the bar keeps its own spacing, boxing and help id. A bar has the
 * §5.1 budget; a group lives inside one item, spends that item's place and is a `span`,
 * as it sits inside that item's inline row. The user's layout (order, More, hidden) and
 * the item menu apply to the desktop bars only: the narrow bar and the sheet are curated
 * lists that keep their default order, so nothing the user hid there is unreachable.
 */
export function TaskHeaderRegionItems({ region, surface = "bar" }: { region: TaskHeaderRegion | TaskHeaderGroup; surface?: TaskHeaderSurface }) {
	const { scope, layout } = useTaskHeaderContext();
	const userLayout = useTaskHeaderUserLayout();
	const hidden = useHiddenControls();
	const [menu, setMenu] = useState<SlotItemMenuRequest | null>(null);
	const openRequest = useRef<SlotItemMenuRequest | null>(null);
	const openMenu = useCallback((request: SlotItemMenuRequest) => {
		openRequest.current = request;
		setMenu(request);
	}, []);
	const closeMenu = useCallback(() => {
		const target = openRequest.current?.returnFocus ?? null;
		openRequest.current = null;
		setMenu(null);
		returnFocusAfterMenu(target);
	}, []);
	const placement = isBar(region) ? { budget: TASK_HEADER_BAR_BUDGET, budgetExempt: TASK_HEADER_BUDGET_EXCEPTIONS } : { as: "span" as const };
	const arranged = surface === "bar" && !layout.narrow;
	return (
		<SurfaceContext.Provider value={surface}>
			<SlotItems
				registry={getTaskHeaderRegistry()}
				region={region}
				scope={scope}
				className="contents"
				{...placement}
				layout={arranged ? regionLayout(userLayout, region, hidden) : undefined}
				onItemMenu={arranged ? openMenu : undefined}
			/>
			{menu && <TaskHeaderItemMenu region={region} request={menu} hidden={hidden} onClose={closeMenu} />}
		</SurfaceContext.Provider>
	);
}
