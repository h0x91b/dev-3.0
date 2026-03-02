import { useEffect, type Dispatch } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import KanbanBoard from "./KanbanBoard";
import TaskTerminal from "./TaskTerminal";
import SplitLayout from "./SplitLayout";

interface ProjectViewProps {
	projectId: string;
	projects: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	activeTaskId?: string;
}

function ProjectView({
	projectId,
	projects,
	tasks,
	dispatch,
	navigate,
	bellCounts,
	activeTaskId,
}: ProjectViewProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);

	useEffect(() => {
		(async () => {
			try {
				const tasks = await api.request.getTasks({ projectId });
				dispatch({ type: "setTasks", tasks });
			} catch (err) {
				console.error("Failed to load tasks:", err);
			}
		})();
	}, [projectId, dispatch]);

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
	}

	if (activeTaskId) {
		return (
			<SplitLayout
				kanbanContent={
					<KanbanBoard
						project={project}
						tasks={tasks}
						dispatch={dispatch}
						navigate={navigate}
						bellCounts={bellCounts}
						activeTaskId={activeTaskId}
					/>
				}
				terminalContent={
					<TaskTerminal
						projectId={projectId}
						taskId={activeTaskId}
						tasks={tasks}
						projects={projects}
						navigate={navigate}
						dispatch={dispatch}
					/>
				}
			/>
		);
	}

	return (
		<div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col">
			<KanbanBoard
				project={project}
				tasks={tasks}
				dispatch={dispatch}
				navigate={navigate}
				bellCounts={bellCounts}
			/>
		</div>
	);
}

export default ProjectView;
