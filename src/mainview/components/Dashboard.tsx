import { useState, type Dispatch } from "react";
import { toast } from "../toast";
import type { Project } from "../../shared/types";
import { orderProjectsForDisplay } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import ActivityOverview from "./ActivityOverview";
import AllTasksBoard from "./AllTasksBoard";
import DashboardViewToggle, {
	readDashboardView,
	writeDashboardView,
	type DashboardView,
} from "./DashboardViewToggle";

interface DashboardProps {
	projects: Project[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	onOpenAddProject: () => void;
}

function Dashboard({ projects, dispatch, navigate, bellCounts, onOpenAddProject }: DashboardProps) {
	const t = useT();
	const [view, setView] = useState<DashboardView>(readDashboardView);

	function changeView(next: DashboardView) {
		setView(next);
		writeDashboardView(next);
		trackEvent("dashboard_view_changed", { view: next });
	}

	const viewToggle = <DashboardViewToggle view={view} onViewChange={changeView} />;

	async function handleRemoveProject(projectId: string) {
		const confirmed = await confirm({
			title: t("dashboard.remove"),
			message: t("dashboard.confirmRemove"),
			danger: true,
		});
		if (!confirmed) return;
		try {
			await api.request.removeProject({ projectId });
			dispatch({ type: "removeProject", projectId });
			trackEvent("project_removed", { project_id: projectId });
		} catch (err) {
			toast.error(t("dashboard.failedRemove", { error: String(err) }));
		}
	}

	async function handleReorderProjects(projectIds: string[]) {
		const previousProjects = projects;
		dispatch({ type: "reorderProjects", projectIds });
		try {
			const reordered = await api.request.reorderProjects({ projectIds });
			// reorderProjects only operates on git projects.json — re-merge virtual
			// boards (Operations) so they are not wiped from state on confirmation.
			const virtuals = previousProjects.filter((p) => p.kind === "virtual");
			dispatch({ type: "setProjects", projects: orderProjectsForDisplay([...reordered, ...virtuals]) });
			trackEvent("projects_reordered", { project_count: projectIds.length });
		} catch (err) {
			dispatch({ type: "setProjects", projects: previousProjects });
			toast.error(t("dashboard.failedReorder", { error: String(err) }));
		}
	}

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-hidden">
				{projects.length > 0 ? (
					view === "board" ? (
						<AllTasksBoard
							projects={projects}
							navigate={navigate}
							bellCounts={bellCounts}
							viewToggle={viewToggle}
						/>
					) : (
						<ActivityOverview
							projects={projects}
							navigate={navigate}
							bellCounts={bellCounts}
							onRemoveProject={handleRemoveProject}
							onOpenAddProject={onOpenAddProject}
							onReorderProjects={handleReorderProjects}
							viewToggle={viewToggle}
						/>
					)
				) : (
					<div className="h-full overflow-y-auto p-7">
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
								{t("dashboard.noProjects")}
							</p>
							<p className="text-fg-3 text-sm mb-5">
								{t("dashboard.noProjectsHint")}
							</p>
							<button
								onClick={onOpenAddProject}
								className="px-5 py-2 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all active:scale-95"
							>
								{t("dashboard.addProject")}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export default Dashboard;
