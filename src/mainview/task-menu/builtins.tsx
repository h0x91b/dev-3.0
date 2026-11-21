import type { Context, Fiber } from "cordis";
import type { Project, TaskPriority, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle, isTaskDisconnected } from "../../shared/types";
import { buildTaskDeepLink } from "../../shared/deep-link";
import type { BuiltinPlugin } from "../plugins/runtime";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { trackEvent, agentNameFromId } from "../analytics";
import { createProjectLabel } from "../utils/createProjectLabel";
import { formatBytes } from "../utils/formatBytes";
import { LAUNCH_REQUESTED_EVENT, moveTaskToStatus, type LaunchRequestedDetail } from "../utils/moveTaskToStatus";
import BottomSheet from "../components/BottomSheet";
import LabelPicker, { LabelPickerPanel } from "../components/LabelPicker";
import MoveToProjectPicker, { MoveToProjectPanel } from "../components/MoveToProjectPicker";
import OpenInMenu, { OpenInAppList } from "../components/OpenInMenu";
import PipelineDropdown from "../components/PipelineDropdown";
import PriorityPicker, { PriorityList } from "../components/PriorityPicker";
// Defines the slot before the plugin injects it.
import "./registry";
import type { TaskMenuItem, TaskMenuScope } from "./registry";

export const TASK_MENU_BUILTIN_ID = "builtin:task-menu";

/** `TaskMenuItem` without what registration assigns; distributive, so run-or-submenu still holds. */
type BuiltinItem = TaskMenuItem extends infer Item ? (Item extends TaskMenuItem ? Omit<Item, "id" | "order"> & { name: string } : never) : never;

function hasSession({ task }: TaskMenuScope): boolean {
	return !!task.worktreePath && !task.hibernated && !task.preparing && !task.shuttingDown && !isTaskDisconnected(task);
}

function copy({ task, t }: TaskMenuScope, text: string) {
	navigator.clipboard.writeText(text);
	toast.success(t("taskMenu.copied"), { taskId: task.id });
}

async function toggleLabel({ task, project, dispatch, t }: TaskMenuScope, labelId: string) {
	const labelIds = task.labelIds ?? [];
	const next = labelIds.includes(labelId) ? labelIds.filter((id) => id !== labelId) : [...labelIds, labelId];
	try {
		const updated = await api.request.setTaskLabels({ taskId: task.id, projectId: project.id, labelIds: next });
		dispatch({ type: "updateTask", task: updated });
	} catch (err) {
		toast.error(t("labels.failedSetLabels", { error: String(err) }), { taskId: task.id });
	}
}

async function setPriority({ task, project, dispatch, t }: TaskMenuScope, priority: TaskPriority) {
	try {
		const changed = await api.request.setTaskPriority({ taskId: task.id, projectId: project.id, priority });
		for (const changedTask of changed) dispatch({ type: "updateTask", task: changedTask });
	} catch (err) {
		toast.error(t("priority.failedSet", { error: String(err) }), { taskId: task.id });
	}
}

async function moveToCustomColumn({ task, project, dispatch, t }: TaskMenuScope, customColumnId: string) {
	try {
		const updated = await api.request.moveTaskToCustomColumn({ taskId: task.id, projectId: project.id, customColumnId });
		dispatch({ type: "updateTask", task: updated });
		trackEvent("task_moved", {
			from_status: task.status,
			to_status: `custom:${customColumnId}`,
			agent_name: agentNameFromId(task.agentId),
		});
	} catch (err) {
		toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
	}
}

async function moveToProject({ task, project, dispatch, t }: TaskMenuScope, target: Project) {
	try {
		await api.request.moveTaskToProject({ taskId: task.id, fromProjectId: project.id, toProjectId: target.id });
		dispatch({ type: "removeTask", taskId: task.id });
		trackEvent("task_moved_to_project", { from_project_id: project.id, to_project_id: target.id });
		toast.success(t("task.movedToProject", { project: target.name }));
	} catch (err) {
		toast.error(t("task.failedMoveToProject", { error: String(err) }), { taskId: task.id });
	}
}

function pipeline(scope: TaskMenuScope, done: () => void, touch: boolean) {
	const { task, project, dispatch, t, openTask } = scope;
	return (
		<PipelineDropdown
			currentStatus={task.status}
			onMove={(newStatus: TaskStatus) => {
				done();
				void moveTaskToStatus({ task, project, newStatus, dispatch, t, onOpenTask: openTask });
			}}
			onMoveToCustomColumn={(id: string) => {
				done();
				void moveToCustomColumn(scope, id);
			}}
			customColumns={project.customColumns}
			currentCustomColumnId={task.customColumnId}
			project={project}
			{...(touch ? { size: "touch" as const, hideHeader: true } : {})}
		/>
	);
}

/** Only a To Do task (not a draft, not one already set to "Start in") can wait to start. */
function canWaitToStart({ task }: TaskMenuScope): boolean {
	return task.status === "todo" && task.draft !== true && !task.scheduledLaunch && !task.worktreePath;
}

/** The menu's own rows, in display order within each group. */
const BUILTIN_ITEMS: readonly BuiltinItem[] = [
	// ── Open ──
	{ name: "open", region: "open", label: ({ t }) => t("taskMenu.open"), run: (s) => s.openTask() },
	{ name: "details", region: "open", label: ({ t }) => t("taskMenu.details"), run: (s) => s.openDetails(false) },
	{ name: "family", region: "open", label: ({ t }) => t("task.lineage.showFamily"), when: (s) => !!s.showFamily, run: (s) => s.showFamily?.() },

	// ── Edit ──
	{
		name: "labels",
		region: "edit",
		label: ({ t }) => t("taskMenu.labels"),
		submenu: {
			width: 220,
			flyout: (scope) => (
				<LabelPickerPanel
					project={scope.project}
					onCreateLabel={(name) => createProjectLabel({ project: scope.project, name, dispatch: scope.dispatch, t: scope.t, taskId: scope.task.id })}
					selectedIds={scope.task.labelIds ?? []}
					onToggle={(id) => toggleLabel(scope, id)}
					autoFocus={false}
				/>
			),
			sheet: (scope, { anchorEl, close }) =>
				anchorEl && (
					<LabelPicker
						project={scope.project}
						onCreateLabel={(name) => createProjectLabel({ project: scope.project, name, dispatch: scope.dispatch, t: scope.t, taskId: scope.task.id })}
						anchorEl={anchorEl}
						selectedIds={scope.task.labelIds ?? []}
						onToggle={(id) => toggleLabel(scope, id)}
						onClose={close}
					/>
				),
		},
	},
	{
		name: "priority",
		region: "edit",
		label: ({ t }) => t("taskMenu.priority"),
		submenu: {
			width: 200,
			flyout: (scope, { done }) => (
				<div className="py-1">
					<PriorityList selected={scope.task.priority} onSelect={(p) => { done(); void setPriority(scope, p); }} />
				</div>
			),
			sheet: (scope, { anchorEl, done, close }) =>
				anchorEl && (
					<PriorityPicker
						selected={scope.task.priority}
						anchorEl={anchorEl}
						onSelect={(p) => { done(); void setPriority(scope, p); }}
						onClose={close}
					/>
				),
		},
	},
	{
		name: "status",
		region: "edit",
		label: ({ t }) => t("task.moveTo"),
		submenu: {
			flyout: (scope, { done }) => <div className="min-w-[11.25rem] py-1.5">{pipeline(scope, done, false)}</div>,
			sheet: (scope, { done, close }) => (
				<BottomSheet open onClose={close} title={scope.t("task.moveTo")} testId={`task-menu-status-sheet-${scope.task.id}`}>
					{pipeline(scope, done, true)}
				</BottomSheet>
			),
		},
	},
	{
		// "Start after…" opens the launch modal on Launch later → After task; the modal owns the picker.
		name: "startAfter",
		region: "edit",
		label: ({ t }) => t("taskMenu.startAfter"),
		when: (s) => !s.task.launchAfter && canWaitToStart(s),
		run: ({ task, project }) => {
			window.dispatchEvent(new CustomEvent<LaunchRequestedDetail>(LAUNCH_REQUESTED_EVENT, {
				detail: { task, project, targetStatus: "in-progress", startAfter: true },
			}));
		},
	},
	{
		name: "removeStartAfter",
		region: "edit",
		label: ({ t }) => t("task.removeStartAfter"),
		when: ({ task }) => task.status === "todo" && !!task.launchAfter,
		run: async ({ task, project, dispatch, t }) => {
			try {
				dispatch({ type: "updateTask", task: await api.request.clearTaskLaunchAfter({ taskId: task.id, projectId: project.id }) });
			} catch (err) {
				toast.error(t("task.startAfterRemoveFailed", { error: String(err) }), { taskId: task.id });
			}
		},
	},
	{
		name: "project",
		region: "edit",
		label: ({ t }) => t("task.moveToProject"),
		submenu: {
			width: 260,
			flyout: (scope, { done }) => (
				<MoveToProjectPanel currentProjectId={scope.project.id} onSelect={(p) => { done(); void moveToProject(scope, p); }} autoFocus={false} />
			),
			sheet: (scope, { anchorEl, done, close }) =>
				anchorEl && (
					<MoveToProjectPicker
						currentProjectId={scope.project.id}
						anchorEl={anchorEl}
						onSelect={(p) => { done(); void moveToProject(scope, p); }}
						onClose={close}
					/>
				),
		},
	},
	{ name: "rename", region: "edit", label: ({ t }) => t("taskMenu.rename"), run: (s) => s.openDetails(true) },

	// ── Workspace ──
	{
		name: "openIn",
		region: "workspace",
		label: ({ t }) => t("openIn.menuTitle"),
		disabled: ({ task }) => !task.worktreePath,
		submenu: {
			flyout: ({ task }, { done }) => (
				<div className="min-w-[11.25rem] py-1.5">
					<OpenInAppList path={task.worktreePath ?? ""} taskId={task.id} onOpened={done} />
				</div>
			),
			sheet: ({ task }, { anchorPos, close }) =>
				task.worktreePath && (
					<OpenInMenu position={{ top: anchorPos.y, left: anchorPos.x }} path={task.worktreePath} taskId={task.id} onClose={close} />
				),
		},
	},
	{ name: "copyLink", region: "workspace", label: ({ t }) => t("taskMenu.copyLink"), run: (s) => copy(s, buildTaskDeepLink(s.task.id)) },
	{
		name: "copyBranch",
		region: "workspace",
		label: ({ t }) => t("taskMenu.copyBranch"),
		disabled: ({ task }) => !task.branchName,
		run: (s) => copy(s, s.task.branchName ?? ""),
	},
	{
		name: "copyPath",
		region: "workspace",
		label: ({ t }) => t("taskMenu.copyPath"),
		disabled: ({ task }) => !task.worktreePath,
		run: (s) => copy(s, s.task.worktreePath ?? ""),
	},

	// ── Session ──
	{
		name: "watch",
		region: "session",
		label: ({ task, t }) => (task.watched ? t("task.unwatchTooltip") : t("task.watch")),
		checked: ({ task }) => !!task.watched,
		run: async ({ task, project, dispatch, t }) => {
			try {
				const updated = await api.request.toggleTaskWatch({ taskId: task.id, projectId: project.id, watched: !task.watched });
				dispatch({ type: "updateTask", task: updated });
			} catch (err) {
				toast.error(t("task.watchFailed", { error: String(err) }), { taskId: task.id });
			}
		},
	},
	{
		name: "hidden",
		region: "session",
		label: ({ task, t }) => (task.hidden ? t("task.showInSidebar") : t("task.hideFromSidebar")),
		checked: ({ task }) => !!task.hidden,
		run: async ({ task, project, dispatch, t }) => {
			try {
				const changed = await api.request.setTaskHidden({ taskId: task.id, projectId: project.id, hidden: !task.hidden });
				for (const changedTask of changed) dispatch({ type: "updateTask", task: changedTask });
			} catch (err) {
				toast.error(t("task.hiddenFailed", { error: String(err) }), { taskId: task.id });
			}
		},
	},
	{
		// The label names the action it will perform, so a checkmark would be redundant.
		name: "keepAlive",
		region: "session",
		label: ({ task, t }) => (task.keepAlive?.enabled ? t("task.keepAliveOff") : t("task.keepAliveOn")),
		run: async ({ task, project, dispatch, t }) => {
			try {
				const updated = await api.request.setTaskKeepAlive({ taskId: task.id, projectId: project.id, enabled: !task.keepAlive?.enabled });
				dispatch({ type: "updateTask", task: updated });
			} catch (err) {
				toast.error(t("task.keepAliveFailed", { error: String(err) }), { taskId: task.id });
			}
		},
	},
	{
		name: "restartSession",
		region: "session",
		label: ({ t }) => t("task.restartSession"),
		disabled: (s) => !(hasSession(s) && ACTIVE_STATUSES.includes(s.task.status) && !s.task.draft),
		run: async ({ task, t }) => {
			if (!await confirm({
				title: t("task.restartSessionTitle"),
				message: t("task.restartSessionConfirm"),
				confirmLabel: t("task.restartSessionCta"),
				danger: true,
				info: { title: getTaskTitle(task) },
			})) return;
			try {
				await api.request.resumeTask({ taskId: task.id, restart: true });
				toast.success(t("task.restartedSession"), { taskId: task.id });
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err), { taskId: task.id });
			}
		},
	},
	{
		name: "hibernate",
		region: "session",
		label: ({ t }) => t("task.hibernate"),
		disabled: (s) => !hasSession(s),
		run: async ({ task, project, dispatch, t }) => {
			const paneCount = task.sessionState?.panes?.length ?? 0;
			const confirmed = await confirm({
				title: t("task.hibernateConfirmTitle"),
				message:
					paneCount > 1
						? `${t("task.hibernateConfirmBody")}\n\n${t("task.hibernateConfirmMulti", { count: String(paneCount) })}`
						: t("task.hibernateConfirmBody"),
				confirmLabel: t("task.hibernateConfirmCta"),
				danger: true,
				info: { title: getTaskTitle(task) },
			});
			if (!confirmed) return;
			try {
				const { task: updated, freedRssBytes } = await api.request.hibernateTask({ taskId: task.id, projectId: project.id });
				dispatch({ type: "updateTask", task: updated });
				toast.success(
					freedRssBytes ? t("task.hibernatedToastMem", { mem: formatBytes(freedRssBytes) }) : t("task.hibernatedToast"),
					{ taskId: task.id },
				);
			} catch (err) {
				toast.error(t("task.hibernateFailed", { error: String(err) }), { taskId: task.id });
			}
		},
	},

	// ── Danger ──
	{
		name: "delete",
		region: "danger",
		label: ({ t }) => t("taskMenu.delete"),
		danger: true,
		run: async ({ task, project, dispatch, t }) => {
			const confirmed = await confirm({
				title: t("task.delete"),
				message: t("task.confirmDelete", { title: getTaskTitle(task) }),
				confirmLabel: t("task.deleteConfirmLabel"),
				danger: true,
			});
			if (!confirmed) return;
			try {
				await api.request.deleteTask({ taskId: task.id, projectId: project.id });
				dispatch({ type: "removeTask", taskId: task.id });
				trackEvent("task_deleted", { project_id: project.id });
			} catch (err) {
				toast.error(t("task.failedDelete", { error: String(err) }), { taskId: task.id });
			}
		},
	},
];

/** Required: the menu has no other source of rows, so the user cannot switch these off. */
export const BUILTIN_TASK_MENU_PLUGIN: BuiltinPlugin = {
	id: TASK_MENU_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: TASK_MENU_BUILTIN_ID,
			inject: ["taskMenu"],
			apply(pluginCtx: Context) {
				BUILTIN_ITEMS.forEach(({ name, ...item }, order) => {
					pluginCtx.taskMenu.register({ ...item, id: `builtin:${name}`, order } as TaskMenuItem);
				});
			},
		});
	},
};
