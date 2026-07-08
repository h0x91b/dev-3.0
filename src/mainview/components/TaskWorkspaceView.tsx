import { useEffect } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import type { NavigationGuard } from "../navigation-guard";
import { api } from "../rpc";
import TaskInfoPanel from "./TaskInfoPanel";
import TaskWorkspacePane from "./TaskWorkspacePane";
import { useTaskInlineDiffState } from "./task-inline-diff";
import { trackDiffView } from "../analytics";

interface TaskWorkspaceViewProps {
	projectId: string;
	taskId: string;
	tasks: Task[];
	projects: Project[];
	navigate: (route: Route) => void;
	dispatch: Dispatch<AppAction>;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
}

function TaskWorkspaceView({
	projectId,
	taskId,
	tasks,
	projects,
	navigate,
	dispatch,
	navigationGuardRef,
}: TaskWorkspaceViewProps) {
	const task = tasks.find((item) => item.id === taskId);
	const project = projects.find((item) => item.id === projectId);
	const inlineDiff = useTaskInlineDiffState(taskId);

	// The fullscreen task view can be entered for a task whose project's tasks
	// were never loaded into `currentProjectTasks` — e.g. quick-shell jumps
	// straight to a fresh scratch op in the built-in Operations board, or a
	// toast / notification click opens a task in a different project. Without the
	// matching task object the header chrome (TaskInfoPanel: task id, Watch,
	// status, tmux controls) silently vanishes and only the bare terminal shows.
	// Load the project's tasks on mount, mirroring ProjectView, so the chrome
	// always renders regardless of the entry point.
	useEffect(() => {
		(async () => {
			try {
				const loaded = await api.request.getTasks({ projectId });
				dispatch({ type: "setTasks", tasks: loaded });
			} catch (err) {
				console.error("Failed to load tasks:", err);
			}
		})();
	}, [projectId, dispatch]);

	// The inline diff opens in-place (not a route) — fire its page view once per
	// open so the diff surface is visible in analytics like any other screen.
	useEffect(() => {
		if (inlineDiff.isOpen) trackDiffView(projectId, taskId);
	}, [inlineDiff.isOpen, projectId, taskId]);

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			{task && project && (
				<TaskInfoPanel
					task={task}
					project={project}
					dispatch={dispatch}
					navigate={navigate}
					isFullPage
					onOpenInlineDiff={inlineDiff.open}
				/>
			)}
			<div className="flex-1 min-h-0 overflow-hidden">
				<TaskWorkspacePane
					projectId={projectId}
					taskId={taskId}
					tasks={tasks}
					projects={projects}
					navigate={navigate}
					dispatch={dispatch}
					inlineDiffRequest={inlineDiff.request}
					onCloseInlineDiff={inlineDiff.close}
					navigationGuardRef={navigationGuardRef}
				/>
			</div>
		</div>
	);
}

export default TaskWorkspaceView;
