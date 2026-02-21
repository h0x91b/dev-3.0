import type { Dispatch } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, STATUS_LABELS } from "../../shared/types";
import type { AppAction, Route } from "../state";
import KanbanColumn from "./KanbanColumn";

interface KanbanBoardProps {
	project: Project;
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function KanbanBoard({ project, tasks, dispatch, navigate }: KanbanBoardProps) {
	const tasksByStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) {
		tasksByStatus.set(status, []);
	}
	for (const task of tasks) {
		tasksByStatus.get(task.status)?.push(task);
	}

	return (
		<div className="flex gap-3 p-4 h-full overflow-x-auto">
			{ALL_STATUSES.map((status) => (
				<KanbanColumn
					key={status}
					status={status}
					label={STATUS_LABELS[status]}
					tasks={tasksByStatus.get(status) || []}
					project={project}
					dispatch={dispatch}
					navigate={navigate}
				/>
			))}
		</div>
	);
}

export default KanbanBoard;
