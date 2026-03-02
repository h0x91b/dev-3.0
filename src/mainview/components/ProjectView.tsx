import { useEffect, type Dispatch } from "react";
import type { Label, Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import KanbanBoard from "./KanbanBoard";

interface ProjectViewProps {
	projectId: string;
	projects: Project[];
	tasks: Task[];
	labels: Label[];
	activeLabelFilter: string[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
}

function ProjectView({
	projectId,
	projects,
	tasks,
	labels,
	activeLabelFilter,
	dispatch,
	navigate,
	bellCounts,
}: ProjectViewProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);

	useEffect(() => {
		(async () => {
			try {
				const [tasks, labels] = await Promise.all([
					api.request.getTasks({ projectId }),
					api.request.getLabels({ projectId }),
				]);
				dispatch({ type: "setTasks", tasks });
				dispatch({ type: "setLabels", labels });
			} catch (err) {
				console.error("Failed to load tasks/labels:", err);
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

	return (
		<div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col">
			<KanbanBoard
				project={project}
				tasks={tasks}
				labels={labels}
				activeLabelFilter={activeLabelFilter}
				dispatch={dispatch}
				navigate={navigate}
				bellCounts={bellCounts}
			/>
		</div>
	);
}

export default ProjectView;
