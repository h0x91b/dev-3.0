import type { Dispatch } from "react";
import type { Project } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";

interface DashboardProps {
	projects: Project[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function Dashboard({ projects, dispatch, navigate }: DashboardProps) {
	async function handleAddProject() {
		try {
			const folder = await api.request.pickFolder();
			if (!folder) return;

			const name = folder.split("/").pop() || folder;
			const result = await api.request.addProject({ path: folder, name });

			if (result.ok) {
				dispatch({ type: "addProject", project: result.project });
			} else {
				alert(result.error);
			}
		} catch (err) {
			alert(`Failed to add project: ${err}`);
		}
	}

	async function handleRemoveProject(projectId: string) {
		if (!confirm("Remove this project from the list?")) return;
		try {
			await api.request.removeProject({ projectId });
			dispatch({ type: "removeProject", projectId });
		} catch (err) {
			alert(`Failed to remove project: ${err}`);
		}
	}

	return (
		<div className="h-screen w-screen flex flex-col bg-[#1a1b26]">
			{/* Header */}
			<div className="flex items-center justify-between px-6 py-4 bg-[#16161e] border-b border-[#292e42]">
				<span className="text-[#c0caf5] font-bold text-lg tracking-wide">
					dev-3.0
				</span>
				<button
					onClick={handleAddProject}
					className="px-4 py-1.5 bg-[#7aa2f7] text-[#1a1b26] text-sm font-medium rounded hover:bg-[#89b4fa] transition-colors"
				>
					Add Project
				</button>
			</div>

			{/* Project list */}
			<div className="flex-1 overflow-y-auto p-6">
				{projects.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full text-[#565f89]">
						<p className="text-lg mb-2">No projects yet</p>
						<p className="text-sm">
							Click "Add Project" to add a git repository
						</p>
					</div>
				) : (
					<div className="grid gap-3 max-w-3xl">
						{projects.map((project) => (
							<div
								key={project.id}
								className="flex items-center justify-between p-4 bg-[#16161e] border border-[#292e42] rounded-lg hover:border-[#3d59a1] transition-colors cursor-pointer"
								onClick={() =>
									navigate({ screen: "project", projectId: project.id })
								}
							>
								<div className="min-w-0 flex-1">
									<div className="text-[#c0caf5] font-medium truncate">
										{project.name}
									</div>
									<div className="text-[#565f89] text-xs mt-1 truncate">
										{project.path}
									</div>
								</div>
								<button
									onClick={(e) => {
										e.stopPropagation();
										handleRemoveProject(project.id);
									}}
									className="ml-4 text-[#565f89] hover:text-[#f7768e] text-sm transition-colors"
								>
									Remove
								</button>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export default Dashboard;
