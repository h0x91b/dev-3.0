import { useState, type Dispatch } from "react";
import type { Project } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import AddProjectModal from "./AddProjectModal";
import ActivityOverview from "./ActivityOverview";
import ProjectActionButtons from "./ProjectActionButtons";

type DashboardTab = "activity" | "projects";

interface DashboardProps {
	projects: Project[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
}

function Dashboard({ projects, dispatch, navigate, bellCounts }: DashboardProps) {
	const t = useT();
	const [showAddModal, setShowAddModal] = useState(false);
	const [tab, setTabRaw] = useState<DashboardTab>(() => {
		if (projects.length === 0) return "projects";
		const saved = sessionStorage.getItem("dev3-dashboard-tab");
		return saved === "activity" || saved === "projects" ? saved : "activity";
	});
	const setTab = (t: DashboardTab) => {
		sessionStorage.setItem("dev3-dashboard-tab", t);
		setTabRaw(t);
	};

	async function handleRemoveProject(projectId: string) {
		const confirmed = await api.request.showConfirm({
			title: t("dashboard.remove"),
			message: t("dashboard.confirmRemove"),
		});
		if (!confirmed) return;
		try {
			await api.request.removeProject({ projectId });
			dispatch({ type: "removeProject", projectId });
			trackEvent("project_removed", { project_id: projectId });
		} catch (err) {
			alert(t("dashboard.failedRemove", { error: String(err) }));
		}
	}

	return (
		<div className="h-full w-full flex flex-col">
			{/* Tab bar */}
			{projects.length > 0 && (
				<div className="flex items-center gap-1 px-7 pt-4 pb-1">
					<button
						onClick={() => setTab("activity")}
						className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
							tab === "activity"
								? "bg-elevated text-fg"
								: "text-fg-3 hover:text-fg-2 hover:bg-raised-hover"
						}`}
					>
						{t("dashboard.tabActivity")}
					</button>
					<button
						onClick={() => setTab("projects")}
						className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
							tab === "projects"
								? "bg-elevated text-fg"
								: "text-fg-3 hover:text-fg-2 hover:bg-raised-hover"
						}`}
					>
						{t("dashboard.tabProjects")}
					</button>
				</div>
			)}
			<div className="flex-1 overflow-hidden">
				{tab === "activity" && projects.length > 0 ? (
					<ActivityOverview
						projects={projects}
						navigate={navigate}
						bellCounts={bellCounts}
						onRemoveProject={handleRemoveProject}
					/>
				) : (
					<div className="h-full overflow-y-auto p-7">
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
									{t("dashboard.noProjects")}
								</p>
								<p className="text-fg-3 text-sm mb-5">
									{t("dashboard.noProjectsHint")}
								</p>
								<button
									onClick={() => setShowAddModal(true)}
									className="px-5 py-2 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all active:scale-95"
								>
									{t("dashboard.addProject")}
								</button>
							</div>
						) : (
							<div className="max-w-5xl mx-auto">
								<div className="flex items-center justify-between mb-5">
									<span className="text-fg-2 text-sm font-medium">
										{t.plural("dashboard.projectCount", projects.length)}
									</span>
									<button
										onClick={() => setShowAddModal(true)}
										className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all active:scale-95"
									>
										{t("dashboard.addProject")}
									</button>
								</div>
								<div className="space-y-2">
									{projects.map((project) => (
										<div
											key={project.id}
											className="group flex items-center gap-4 px-5 py-4 bg-raised rounded-2xl hover:bg-raised-hover border border-edge hover:border-edge-active transition-all cursor-pointer"
											onClick={() =>
												navigate({
													screen: "project",
													projectId: project.id,
												})
											}
										>
											<div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
												<span
													className="text-[1.1rem] leading-none text-accent"
													style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
												>
													{"\u{F126F}"}
												</span>
											</div>
											<div className="min-w-0 flex-1">
												<div className="text-fg font-semibold text-base truncate">
													{project.name}
												</div>
												<div className="text-fg-3 text-xs mt-0.5 truncate font-mono">
													{project.path}
												</div>
											</div>
											<ProjectActionButtons
												project={project}
												navigate={navigate}
												onRemove={handleRemoveProject}
												className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
											/>
											<span
												className="text-[0.875rem] leading-none text-fg-muted group-hover:text-fg-3 transition-colors flex-shrink-0"
												style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
											>
												{"\u{F0142}"}
											</span>
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
			{showAddModal && (
				<AddProjectModal
					dispatch={dispatch}
					onClose={() => setShowAddModal(false)}
				/>
			)}
		</div>
	);
}

export default Dashboard;
