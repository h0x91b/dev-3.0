import type { Dispatch, MutableRefObject } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import type { NavigationGuard } from "../navigation-guard";
import TaskInfoPanel from "./TaskInfoPanel";
import TaskWorkspacePane from "./TaskWorkspacePane";
import { useTaskInlineDiffState } from "./task-inline-diff";

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
