import { useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import type { Label, Project, Task, TaskPriority } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { getTaskOpenMode, taskOpenRoute, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import TaskContextMenu from "../components/TaskContextMenu";
import type { BoardActions } from "./board-service";

interface UseBoardActionsOptions {
	tasks: readonly Task[];
	projects: readonly Project[];
	projectOf: (task: Task) => Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	spaceId?: string;
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
export function useBoardActions({ tasks, projects, projectOf, dispatch, navigate, spaceId }: UseBoardActionsOptions): { actions: BoardActions; overlay: ReactNode } {
	const t = useT();
	const [menu, setMenu] = useState<{ taskId: string; pos: { x: number; y: number } } | null>(null);
	// Actions are called from views long after a render; they must see live tasks.
	const live = useRef({ tasks, projects, projectOf, dispatch, navigate, spaceId, t });
	live.current = { tasks, projects, projectOf, dispatch, navigate, spaceId, t };

	const actions = useMemo<BoardActions>(() => {
		const find = (id: string) => live.current.tasks.find((task) => task.id === id);
		const require = (id: string) => {
			const task = find(id);
			if (!task) throw new Error(`Task not on this board: ${id}`);
			return { task, project: live.current.projectOf(task), ...live.current };
		};
		const moveToStatus = async (id: string, newStatus: Task["status"]) => {
			const { task, project, dispatch, navigate, spaceId, t } = require(id);
			await moveTaskToStatus({ task, project, newStatus, dispatch, t, onOpenTask: () => navigate(openRoute(task, spaceId)) });
		};
		return {
			openTask(id) {
				const task = find(id);
				if (task) live.current.navigate(openRoute(task, live.current.spaceId));
			},
			openContextMenu(id, at) {
				if (find(id)) setMenu({ taskId: id, pos: at });
			},
			async moveTask(id, to) {
				if (to.customColumnId) {
					const { task, project, dispatch, t } = require(id);
					if (task.customColumnId === to.customColumnId) return;
					try {
						const updated = await api.request.moveTaskToCustomColumn({ taskId: task.id, projectId: project.id, customColumnId: to.customColumnId });
						dispatch({ type: "updateTask", task: updated });
					} catch (err) {
						toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
					}
					return;
				}
				if (to.status) await moveToStatus(id, to.status);
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
				try {
					const label = await api.request.createLabel({ projectId, name });
					dispatch({ type: "updateProject", project: { ...project, labels: [...(project.labels ?? []), label] } });
					return label;
				} catch (err) {
					toast.error(t("labels.failedCreate", { error: String(err) }));
					throw err;
				}
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
