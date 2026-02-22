import { useState, type Dispatch } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { useT, statusKey } from "../i18n";
import KanbanColumn from "./KanbanColumn";
import CreateTaskModal from "./CreateTaskModal";

interface KanbanBoardProps {
	project: Project;
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function KanbanBoard({ project, tasks, dispatch, navigate }: KanbanBoardProps) {
	const t = useT();
	const [showCreateModal, setShowCreateModal] = useState(false);

	const tasksByStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) {
		tasksByStatus.set(status, []);
	}
	for (const task of tasks) {
		tasksByStatus.get(task.status)?.push(task);
	}

	return (
		<>
			<div className="flex gap-3 p-5 h-full min-h-0 overflow-x-auto overflow-y-hidden">
				{ALL_STATUSES.map((status) => (
					<KanbanColumn
						key={status}
						status={status}
						label={t(statusKey(status))}
						tasks={tasksByStatus.get(status) || []}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
						onAddTask={() => setShowCreateModal(true)}
					/>
				))}
			</div>

			{showCreateModal && (
				<CreateTaskModal
					project={project}
					dispatch={dispatch}
					onClose={() => setShowCreateModal(false)}
				/>
			)}
		</>
	);
}

export default KanbanBoard;
