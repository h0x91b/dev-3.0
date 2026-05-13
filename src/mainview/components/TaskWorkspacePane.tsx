import type { Dispatch, MutableRefObject } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import type { NavigationGuard } from "../navigation-guard";
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
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
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
	navigationGuardRef,
}: TaskWorkspacePaneProps) {
	const task = tasks.find((item) => item.id === taskId);
	const project = projects.find((item) => item.id === projectId);

	return (
		<div className="h-full w-full relative overflow-hidden">
			<div className={inlineDiffRequest ? "h-full hidden" : "h-full"}>
				{/* key={taskId} forces a fresh TaskTerminal instance per task.
				   Without it, the previous task's cached `ptyUrl` state is
				   still in scope when `taskId` changes, so TerminalView
				   first remounts with (old url + new taskId), repaints the
				   leaving task's content in the freshly re-created canvas,
				   then remounts again once the new url arrives — producing
				   the "clean of screen of the task we leave" flicker. */}
				<TaskTerminal
					key={taskId}
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
						navigationGuardRef={navigationGuardRef}
					/>
				</div>
			)}
		</div>
	);
}

export default TaskWorkspacePane;
