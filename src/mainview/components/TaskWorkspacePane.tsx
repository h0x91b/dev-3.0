import type { Dispatch } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import TaskTerminal from "./TaskTerminal";
import TaskDiffViewer from "./TaskDiffViewer";
import type { TaskInlineDiffRequest } from "./task-inline-diff";

interface TaskWorkspacePaneProps {
	projectId: string;
	taskId: string;
	tasks: Task[];
	projects: Project[];
	navigate: (route: Route) => void;
	dispatch: Dispatch<AppAction>;
	inlineDiffRequest: TaskInlineDiffRequest | null;
	onCloseInlineDiff: () => void;
}

function TaskWorkspacePane({
	projectId,
	taskId,
	tasks,
	projects,
	navigate,
	dispatch,
	inlineDiffRequest,
	onCloseInlineDiff,
}: TaskWorkspacePaneProps) {
	const task = tasks.find((item) => item.id === taskId);
	const project = projects.find((item) => item.id === projectId);

	return (
		<div className="h-full w-full relative overflow-hidden">
			<div className={inlineDiffRequest ? "h-full hidden" : "h-full"}>
				<TaskTerminal
					projectId={projectId}
					taskId={taskId}
					tasks={tasks}
					projects={projects}
					navigate={navigate}
					dispatch={dispatch}
					hideInfoPanel
				/>
			</div>

			{inlineDiffRequest && task && project && (
				<div className="absolute inset-0">
					<TaskDiffViewer
						task={task}
						project={project}
						request={inlineDiffRequest}
						onBack={onCloseInlineDiff}
					/>
				</div>
			)}
		</div>
	);
}

export default TaskWorkspacePane;
