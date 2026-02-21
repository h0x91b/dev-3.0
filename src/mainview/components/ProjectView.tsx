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
			<div className="h-full w-full flex items-center justify-center bg-base">
				<span className="text-danger text-base">Project not found</span>
			</div>
		);
	}

	return (
		<div className="h-full w-full flex flex-col bg-base">
			{/* Header */}
			<div className="flex items-center justify-between px-6 py-4 border-b border-edge">
				<div className="flex items-center gap-4">
					<button
						onClick={() => navigate({ screen: "dashboard" })}
						className="text-fg-3 hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated"
					>
						<svg
							className="w-5 h-5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M15 19l-7-7 7-7"
							/>
						</svg>
					</button>
					<span className="text-fg font-bold text-lg">
						{project.name}
					</span>
				</div>
				<button
					onClick={() =>
						navigate({ screen: "project-settings", projectId })
					}
					className="text-fg-3 hover:text-fg transition-colors p-2 rounded-lg hover:bg-elevated"
					title="Settings"
				>
					<svg
						className="w-5 h-5"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
						/>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
						/>
					</svg>
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
