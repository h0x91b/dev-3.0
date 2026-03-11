import { useState, type Dispatch } from "react";
import type { Project } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import AddProjectModal from "./AddProjectModal";
import ActivityOverview from "./ActivityOverview";

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
	const [tab, setTab] = useState<DashboardTab>(projects.length > 0 ? "activity" : "projects");

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
							<div className="max-w-3xl mx-auto">
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
								<div className="space-y-3">
									{projects.map((project) => (
										<div
											key={project.id}
											className="group flex items-center gap-5 p-5 bg-raised rounded-2xl hover:bg-raised-hover border border-edge hover:border-edge-active transition-all cursor-pointer"
											onClick={() =>
												navigate({
													screen: "project",
													projectId: project.id,
												})
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
													navigate({ screen: "project-settings", projectId: project.id });
												}}
												className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-fg transition-all p-1.5 rounded-lg hover:bg-elevated"
												title={t("header.projectSettings")}
											>
												<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
													<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
												</svg>
											</button>
											<button
												onClick={(e) => {
													e.stopPropagation();
													api.request.openFolder({ path: project.path }).catch(() => {});
												}}
												className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-fg text-sm font-medium transition-all px-3 py-1.5 rounded-lg hover:bg-elevated"
											>
												{t("dashboard.openInFinder")}
											</button>
											<button
												onClick={(e) => {
													e.stopPropagation();
													handleRemoveProject(project.id);
												}}
												className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-danger text-sm font-medium transition-all px-3 py-1.5 rounded-lg hover:bg-danger/10"
											>
												{t("dashboard.remove")}
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
