import { useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import type { CustomColumn, Label, Project, Task, TaskPriority } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { getTaskOpenMode, taskOpenRoute, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { createProjectLabel } from "../utils/createProjectLabel";
import { confirmCustomColumnDelete } from "../utils/confirmCustomColumnDelete";
import TaskContextMenu from "../components/TaskContextMenu";
import type { BoardAllActions } from "./board-service";

interface UseBoardActionsOptions {
	tasks: readonly Task[];
	projects: readonly Project[];
	projectOf: (task: Task) => Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	spaceId?: string;
	/** The project whose columns a column action edits; null on a space board, where they reject. */
	columnOwner: Project | null;
	/** The lane ids in display order, as the board currently draws them. */
	laneOrder: () => string[];
}

/** A task's workspace, or — without one — its board's detail modal, as every other open path does. */
function openRoute(task: Task, spaceId: string | undefined): Route {
	const archived = !ACTIVE_STATUSES.includes(task.status);
	const route = taskOpenRoute(task.id, task.projectId, getTaskOpenMode(), archived);
	return route.screen === "project" && spaceId ? { ...route, spaceId } : route;
}

/**
 * `ctx.board`'s actions (D4) as thin wrappers over the paths the Kanban card and
 * the context menu already use — the same RPCs, the same confirm and launch
 * flows. Returns the context menu it renders, which the host mounts.
 */
export function useBoardActions({ tasks, projects, projectOf, dispatch, navigate, spaceId, columnOwner, laneOrder }: UseBoardActionsOptions): { actions: BoardAllActions; overlay: ReactNode } {
	const t = useT();
	const [menu, setMenu] = useState<{ taskId: string; pos: { x: number; y: number } } | null>(null);
	// Actions are called from views long after a render; they must see live tasks.
	const live = useRef({ tasks, projects, projectOf, dispatch, navigate, spaceId, t, columnOwner, laneOrder });
	live.current = { tasks, projects, projectOf, dispatch, navigate, spaceId, t, columnOwner, laneOrder };

	const actions = useMemo<BoardAllActions>(() => {
		const find = (id: string) => live.current.tasks.find((task) => task.id === id);
		const require = (id: string) => {
			const task = find(id);
			if (!task) throw new Error(`Task not on this board: ${id}`);
			return { task, project: live.current.projectOf(task), ...live.current };
		};
		const moveToStatus = async (id: string, newStatus: Task["status"], onMovingChange?: (moving: boolean) => void) => {
			const { task, project, dispatch, navigate, spaceId, t } = require(id);
			await moveTaskToStatus({ task, project, newStatus, dispatch, t, onOpenTask: () => navigate(openRoute(task, spaceId)), onMovingChange });
		};
		// Column edits belong to ONE project's board; a merged space lane has no single name or order to write.
		const owner = () => {
			const project = live.current.columnOwner;
			if (!project) throw new Error("Column actions are not available on a space board");
			return { project, customColumns: project.customColumns ?? [], ...live.current };
		};
		return {
			openTask(id) {
				const task = find(id);
				if (task) live.current.navigate(openRoute(task, live.current.spaceId));
			},
			openContextMenu(id, at) {
				if (find(id)) setMenu({ taskId: id, pos: at });
			},
			async moveTask(id, to, opts) {
				if (to.customColumnId) {
					const { task, project, dispatch, t } = require(id);
					if (task.customColumnId === to.customColumnId) return;
					// Optimistic, so the card lands at once; reverted when the RPC fails.
					dispatch({ type: "updateTask", task: { ...task, customColumnId: to.customColumnId } });
					opts?.onMovingChange?.(true);
					try {
						const updated = await api.request.moveTaskToCustomColumn({ taskId: task.id, projectId: project.id, customColumnId: to.customColumnId });
						dispatch({ type: "updateTask", task: updated });
					} catch (err) {
						dispatch({ type: "updateTask", task });
						toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
					} finally {
						opts?.onMovingChange?.(false);
					}
					return;
				}
				if (to.status) await moveToStatus(id, to.status, opts?.onMovingChange);
			},
			async setPriority(id, priority: TaskPriority) {
				const { task, project, dispatch, t } = require(id);
				try {
					const changed = await api.request.setTaskPriority({ taskId: task.id, projectId: project.id, priority });
					for (const changedTask of changed) dispatch({ type: "updateTask", task: changedTask });
				} catch (err) {
					toast.error(t("priority.failedSet", { error: String(err) }), { taskId: task.id });
				}
			},
			async setLabels(id, labelIds) {
				const { task, project, dispatch, t } = require(id);
				try {
					const updated = await api.request.setTaskLabels({ taskId: task.id, projectId: project.id, labelIds });
					dispatch({ type: "updateTask", task: updated });
				} catch (err) {
					toast.error(t("labels.failedSetLabels", { error: String(err) }), { taskId: task.id });
				}
			},
			// Same steps as LabelPicker's "create": the label is project-wide at once.
			async createLabel(projectId, name): Promise<Label> {
				const { projects, dispatch, t } = live.current;
				const project = projects.find((p) => p.id === projectId);
				if (!project) throw new Error(`Project not on this board: ${projectId}`);
				return createProjectLabel({ project, name, dispatch, t });
			},
			createTask() {
				window.dispatchEvent(new CustomEvent("rpc:openCreateTaskModal"));
			},
			// A To Do task launches through the app's launch modal (moveTaskToStatus
			// raises it), with the stale-worktree reset consent in front of it.
			launch: (id) => moveToStatus(id, "in-progress"),
			async remove(id, kind) {
				if (kind === "cancel") {
					await moveToStatus(id, "cancelled");
					return;
				}
				const { task, project, dispatch, t } = require(id);
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
			async renameColumn(status, name) {
				const { project, dispatch } = owner();
				try {
					const updated = await api.request.renameBuiltinColumn({ projectId: project.id, status, name });
					dispatch({ type: "updateProject", project: updated });
				} catch (err) {
					console.error("Failed to rename column:", err);
				}
			},
			// The server picks a distinct colour; the column lands right before Completed,
			// and the full order is persisted because the create RPC returns only the column.
			async createColumn() {
				// Snapshot before the await: the server's project push can land first, and
				// the live state would then already hold the new column.
				const { project, customColumns, dispatch, t, laneOrder } = owner();
				const lanesBefore = laneOrder();
				try {
					const column = await api.request.createCustomColumn({ projectId: project.id, name: t("customColumns.defaultName") });
					const columnOrder = lanesBefore.filter((id) => id !== column.id);
					const completedIndex = columnOrder.indexOf("completed");
					columnOrder.splice(completedIndex === -1 ? columnOrder.length : completedIndex, 0, column.id);
					const others = customColumns.filter((c) => c.id !== column.id);
					dispatch({ type: "updateProject", project: { ...project, customColumns: [...others, column], columnOrder } });
					api.request.reorderColumns({ projectId: project.id, columnOrder }).catch((err) => {
						toast.error(t("kanban.failedReorderColumns", { error: String(err) }), { projectId: project.id });
					});
					return column.id;
				} catch (err) {
					toast.error(t("customColumns.failedCreate", { error: String(err) }), { projectId: project.id });
					return null;
				}
			},
			// Only the name changes; the server's merge keeps colour, instruction and agent.
			async renameCustomColumn(columnId, name) {
				const { project, customColumns, dispatch, t } = owner();
				const trimmed = name.trim();
				if (!trimmed) return;
				try {
					const column = await api.request.updateCustomColumn({ projectId: project.id, columnId, name: trimmed });
					dispatch({ type: "updateProject", project: { ...project, customColumns: customColumns.map((c) => (c.id === columnId ? column : c)) } });
				} catch (err) {
					toast.error(t("customColumns.failedUpdate", { error: String(err) }), { projectId: project.id });
				}
			},
			async deleteCustomColumn(columnId) {
				const before = owner();
				const column = before.customColumns.find((c) => c.id === columnId);
				if (!column || !(await confirmCustomColumnDelete(column, [...before.tasks], before.t))) return;
				// Re-read after the dialog: the project may have changed while it was open.
				const { project, customColumns, dispatch, t } = owner();
				try {
					await api.request.deleteCustomColumn({ projectId: project.id, columnId });
					dispatch({ type: "updateProject", project: { ...project, customColumns: customColumns.filter((c) => c.id !== columnId) } });
				} catch (err) {
					toast.error(t("customColumns.failedDelete", { error: String(err) }), { projectId: project.id });
				}
			},
			async reorderColumns(order) {
				const { project, customColumns, dispatch, t } = owner();
				const reorderedCustom = order
					.map((id) => customColumns.find((c) => c.id === id))
					.filter((c): c is CustomColumn => c !== undefined);
				dispatch({ type: "updateProject", project: { ...project, customColumns: reorderedCustom, columnOrder: order } });
				try {
					await api.request.reorderColumns({ projectId: project.id, columnOrder: order });
				} catch (err) {
					toast.error(t("kanban.failedReorderColumns", { error: String(err) }), { projectId: project.id });
				}
			},
		};
	}, []);

	const menuTask = menu ? tasks.find((task) => task.id === menu.taskId) : undefined;
	const overlay = menuTask ? (
		<TaskContextMenu
			task={menuTask}
			project={projectOf(menuTask)}
			dispatch={dispatch}
			pos={menu!.pos}
			onClose={() => setMenu(null)}
			onOpenTask={() => navigate(openRoute(menuTask, spaceId))}
			testId={`board-task-menu-${menuTask.id}`}
		/>
	) : null;
	return { actions, overlay };
}
