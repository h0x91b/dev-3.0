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
		<div className="h-full w-full flex flex-col bg-base">
			{/* Header */}
			<div className="flex items-center justify-between px-7 py-5 border-b border-edge">
				<div className="flex items-center gap-3">
					<div className="w-3 h-3 rounded-full bg-accent" />
					<span className="text-fg font-bold text-xl tracking-tight">
						dev-3.0
					</span>
				</div>
				<button
					onClick={handleAddProject}
					className="px-5 py-2 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all active:scale-95"
				>
					Add Project
				</button>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-7">
				{projects.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full">
						<div className="w-20 h-20 rounded-2xl bg-raised flex items-center justify-center mb-5">
							<svg
								className="w-10 h-10 text-fg-muted"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={1.5}
									d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
								/>
							</svg>
						</div>
						<p className="text-fg-2 text-lg font-medium mb-1">
							No projects yet
						</p>
						<p className="text-fg-3 text-sm">
							Add a git repository to get started
						</p>
					</div>
				) : (
					<div className="max-w-3xl mx-auto space-y-3">
						{projects.map((project) => (
							<div
								key={project.id}
								className="group flex items-center gap-5 p-5 bg-raised rounded-2xl hover:bg-raised-hover border border-edge hover:border-edge-active transition-all cursor-pointer"
								onClick={() =>
									navigate({ screen: "project", projectId: project.id })
								}
							>
								<div className="w-12 h-12 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
									<svg
										className="w-6 h-6 text-accent"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={1.5}
											d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
										/>
									</svg>
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-fg font-semibold text-base truncate">
										{project.name}
									</div>
									<div className="text-fg-3 text-sm mt-1 truncate font-mono">
										{project.path}
									</div>
								</div>
								<button
									onClick={(e) => {
										e.stopPropagation();
										handleRemoveProject(project.id);
									}}
									className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-danger text-sm font-medium transition-all px-3 py-1.5 rounded-lg hover:bg-danger/10"
								>
									Remove
								</button>
								<svg
									className="w-5 h-5 text-fg-muted group-hover:text-fg-3 transition-colors flex-shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M9 5l7 7-7 7"
									/>
								</svg>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export default Dashboard;
