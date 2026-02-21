import { useEffect, type Dispatch } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import KanbanBoard from "./KanbanBoard";

interface ProjectViewProps {
	projectId: string;
	projects: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function ProjectView({
	projectId,
	projects,
	tasks,
	dispatch,
	navigate,
}: ProjectViewProps) {
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
			<div className="h-screen w-screen flex items-center justify-center bg-[#1a1b26]">
				<span className="text-[#f7768e]">Project not found</span>
			</div>
		);
	}

	return (
		<div className="h-screen w-screen flex flex-col bg-[#1a1b26]">
			{/* Header */}
			<div className="flex items-center justify-between px-6 py-3 bg-[#16161e] border-b border-[#292e42]">
				<div className="flex items-center gap-4">
					<button
						onClick={() => navigate({ screen: "dashboard" })}
						className="text-[#565f89] hover:text-[#c0caf5] text-sm transition-colors"
					>
						&larr; Back
					</button>
					<span className="text-[#c0caf5] font-bold text-lg">
						{project.name}
					</span>
				</div>
				<button
					onClick={() =>
						navigate({ screen: "project-settings", projectId })
					}
					className="text-[#565f89] hover:text-[#c0caf5] text-sm transition-colors"
				>
					Settings
				</button>
			</div>

			{/* Kanban */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<KanbanBoard
					project={project}
					tasks={tasks}
					dispatch={dispatch}
					navigate={navigate}
				/>
			</div>
		</div>
	);
}

export default ProjectView;
