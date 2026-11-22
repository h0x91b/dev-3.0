import type { ComponentType } from "react";
import { ACTIVE_STATUSES, taskUsesWorktree } from "../../shared/types";
import { useT } from "../i18n";
import { useIsSimplifyViewApplied } from "../hooks/useIsControlHidden";
import type { TranslationKey } from "../i18n";
import Tooltip from "../components/Tooltip";
import ScheduledMessagesChip from "../components/ScheduledMessagesChip";
import HeldMessagesChip from "../components/HeldMessagesChip";
import TaskPaneControls from "../components/task-info-panel/TaskPaneControls";
import { AddAgentIcon, FindBugsIcon, HibernateIcon, SendLaterIcon } from "../components/TaskIcons";
import type { SlotItemProps } from "../plugins/SlotItems";
import type { TaskHeaderItem, TaskHeaderScope } from "./registry";
import { useTaskHeaderInternals, useTaskHeaderScope, useTaskHeaderSurface } from "./scope";
import { SHEET_ROW_CLASS } from "./sheet-row";

/**
 * The Session/Agent bar (bible §5.1, panel 3) as built-in items. The dialogs these items
 * open have one owner, the header (`useTaskSessionController`), because the panel's
 * restore control (chrome) opens them too. Hiding and moving them is the host's. ⚙ worktree settings, restore, help and
 * shortcuts stay host chrome.
 */

// --- gates -----------------------------------------------------------------------------

/** Every session control drives the task's live agent: an active task with a worktree. */
function hasLiveSession({ task }: TaskHeaderScope): boolean {
	return ACTIVE_STATUSES.includes(task.status) && !!task.worktreePath;
}

function canHuntBugs(scope: TaskHeaderScope): boolean {
	return hasLiveSession(scope) && taskUsesWorktree(scope.project, scope.task);
}

function canHibernate(scope: TaskHeaderScope): boolean {
	const { task } = scope;
	return hasLiveSession(scope) && !task.hibernated && !task.preparing && !task.shuttingDown;
}

/** The desktop session bar; the narrow summary bar carries no session controls. */
function useOnDesktopBar(): boolean {
	const surface = useTaskHeaderSurface();
	const { layout } = useTaskHeaderInternals();
	return surface === "bar" && !layout.narrow;
}

/** Simplified Mode applies on the sheet; personal hiding does not, the phone has no restore control. */
function useOnSheet(): boolean {
	const surface = useTaskHeaderSurface();
	const simplified = useIsSimplifyViewApplied();
	return surface === "sheet" && !simplified;
}

// --- items -----------------------------------------------------------------------------

const BAR_BUTTON_CLASS = "task-anim flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-fg-3 hover:text-fg hover:bg-elevated border border-edge";
const BAR_ICON_CLASS = "w-[1.05rem] h-[1.05rem]";
const BAR_LABEL_CLASS = "text-micro font-semibold whitespace-nowrap";

function ChevronRightIcon() {
	return (
		<svg className="h-4 w-4 shrink-0 text-fg-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
		</svg>
	);
}

function BugHuntersItem() {
	const t = useT();
	const { layout, session } = useTaskHeaderInternals();
	const onBar = useOnDesktopBar();
	const onSheet = useOnSheet();
	if (onSheet) {
		return (
			<button type="button" data-testid="task-actions-bug-hunters" onClick={session.openBugHunters} className={SHEET_ROW_CLASS}>
				<FindBugsIcon className="h-5 w-5 shrink-0 text-danger" />
				<span className="flex-1 text-sm font-medium">{t("bugHunters.buttonLabel")}</span>
				<ChevronRightIcon />
			</button>
		);
	}
	if (!onBar) return null;
	return (
		<Tooltip content={t("bugHunters.buttonTooltip")} detail={t("ttip.infoPanel.bugHunters")}>
			<button onClick={session.openBugHunters} className={BAR_BUTTON_CLASS} aria-label={t("bugHunters.buttonTooltip")}>
				<FindBugsIcon className={BAR_ICON_CLASS} />
				{!layout.compact && <span className={BAR_LABEL_CLASS}>{t("bugHunters.buttonLabel")}</span>}
			</button>
		</Tooltip>
	);
}

function SpawnAgentItem() {
	const t = useT();
	const { layout, session } = useTaskHeaderInternals();
	const onBar = useOnDesktopBar();
	const onSheet = useOnSheet();
	if (onSheet) {
		return (
			<button type="button" data-testid="task-actions-spawn-agent" onClick={session.openSpawnAgent} className={SHEET_ROW_CLASS}>
				<AddAgentIcon className="h-5 w-5 shrink-0 text-success" />
				<span className="flex-1 text-sm font-medium">{t("tmux.spawnExtraAgent")}</span>
				<ChevronRightIcon />
			</button>
		);
	}
	if (!onBar) return null;
	return (
		<Tooltip content={t("tmux.spawnExtraAgentDesc")} detail={t("ttip.infoPanel.spawnAgent")}>
			<button onClick={session.openSpawnAgent} className={BAR_BUTTON_CLASS} aria-label={t("tmux.spawnExtraAgentDesc")}>
				<AddAgentIcon className={BAR_ICON_CLASS} />
				{!layout.compact && <span className={BAR_LABEL_CLASS}>{t("tmux.spawnExtraAgent")}</span>}
			</button>
		</Tooltip>
	);
}

/** Queues a message to the live agent; the compact "Later" label keeps the bar tight. */
function SendLaterItem() {
	const t = useT();
	const { layout, session } = useTaskHeaderInternals();
	if (!useOnDesktopBar()) return null;
	return (
		<Tooltip content={t("task.sendLater")} detail={t("task.sendLaterHint")}>
			<button onClick={session.openScheduleMessage} className={BAR_BUTTON_CLASS} aria-label={t("task.sendLater")}>
				<SendLaterIcon className={BAR_ICON_CLASS} />
				{!layout.compact && <span className={BAR_LABEL_CLASS}>{t("task.sendLaterShort")}</span>}
			</button>
		</Tooltip>
	);
}

/**
 * Parks the task: kills the agent, its tmux session and the dev server, keeps the worktree.
 * Amber, not danger: red means "destroys something you cannot get back". The skull is the
 * bar's one filled glyph on purpose, so it stops the eye before the tooltip explains.
 */
function HibernateItem() {
	const t = useT();
	const { layout, session, closeSheet } = useTaskHeaderInternals();
	const onBar = useOnDesktopBar();
	const onSheet = useOnSheet();
	if (onSheet) {
		return (
			<button
				type="button"
				data-testid="task-actions-hibernate"
				disabled={session.hibernating}
				onClick={() => {
					closeSheet();
					void session.hibernate();
				}}
				className={`${SHEET_ROW_CLASS} disabled:opacity-50`}
			>
				<HibernateIcon className="h-5 w-5 shrink-0 text-warning-strong" />
				<span className="flex-1 text-sm font-medium">{t("task.hibernate")}</span>
			</button>
		);
	}
	if (!onBar) return null;
	return (
		<Tooltip content={t("task.hibernate")} detail={t("task.hibernateHint")}>
			<button
				data-testid="task-hibernate-button"
				onClick={session.hibernate}
				disabled={session.hibernating}
				className="task-anim warning-paper flex items-center gap-1 px-2 py-1 rounded-lg transition-colors text-warning-strong hover:bg-warning/15 border border-warning/30 disabled:opacity-50"
				aria-label={t("task.hibernate")}
			>
				{session.hibernating ? (
					<span className="w-[1.05rem] h-[1.05rem] animate-spin rounded-full border-2 border-warning/30 border-t-warning" />
				) : (
					<HibernateIcon className={BAR_ICON_CLASS} />
				)}
				{!layout.compact && <span className={BAR_LABEL_CLASS}>{t("task.hibernateShort")}</span>}
			</button>
		</Tooltip>
	);
}

/** Messages held behind an agent prompt, then the pending scheduled ones; both open downward. */
function ScheduledMessagesItem() {
	const { task, project, dispatch } = useTaskHeaderScope();
	if (!useOnDesktopBar()) return null;
	return (
		<>
			<HeldMessagesChip taskId={task.id} placement="down" />
			<ScheduledMessagesChip task={task} project={project} dispatch={dispatch} placement="down" />
		</>
	);
}

function PaneControlsItem() {
	const { task } = useTaskHeaderScope();
	const { layout } = useTaskHeaderInternals();
	if (!useOnDesktopBar()) return null;
	return (
		<>
			<div className="w-px h-6 self-center bg-edge flex-shrink-0 mx-1" aria-hidden="true" />
			<TaskPaneControls taskId={task.id} compact={layout.tight} />
		</>
	);
}

function item(id: string, component: ComponentType<SlotItemProps>, when?: TaskHeaderItem["when"]): TaskHeaderItem {
	return { id: `builtin:session.${id}`, region: "session", label: `taskHeaderItem.session.${id}` as TranslationKey, component, when };
}

/** The session bar, left to right; the narrow sheet's session section reads the same order. */
export const SESSION_ITEMS: readonly TaskHeaderItem[] = [
	item("bug-hunters", BugHuntersItem, canHuntBugs),
	item("spawn-agent", SpawnAgentItem, hasLiveSession),
	item("send-later", SendLaterItem, hasLiveSession),
	item("hibernate", HibernateItem, canHibernate),
	item("scheduled-messages", ScheduledMessagesItem, hasLiveSession),
	item("pane-controls", PaneControlsItem),
];
