import { useState, useEffect, useCallback } from "react";
import type { DragEvent } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { useStatusColors } from "../hooks/useStatusColors";
import ProjectActionButtons from "./ProjectActionButtons";

interface ActivityOverviewProps {
	projects: Project[];
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	onRemoveProject?: (projectId: string) => void | Promise<void>;
	onOpenAddProject?: () => void;
	onReorderProjects?: (projectIds: string[]) => void | Promise<void>;
}

/** Statuses that require the user's attention — shown as individual task rows. */
const ATTENTION_STATUSES: TaskStatus[] = ["user-questions", "review-by-user"];

/** Statuses that are "background work" — collapsed into a summary line. */
const BACKGROUND_STATUSES: TaskStatus[] = ["in-progress", "review-by-ai", "review-by-colleague"];

type DropSide = "before" | "after";

function timeAgo(isoDate: string | undefined, t: (key: any, vars?: any) => string): string {
	if (!isoDate) return "";
	const diff = Date.now() - new Date(isoDate).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return t("activity.justNow");
	if (mins < 60) return t("activity.minutesAgo", { count: String(mins) });
	const hours = Math.floor(mins / 60);
	if (hours < 24) return t("activity.hoursAgo", { count: String(hours) });
	const days = Math.floor(hours / 24);
	return t("activity.daysAgo", { count: String(days) });
}

function ActivityOverview({ projects, navigate, bellCounts, onRemoveProject, onOpenAddProject, onReorderProjects }: ActivityOverviewProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const [tasksByProject, setTasksByProject] = useState<Map<string, Task[]>>(new Map());
	const [loading, setLoading] = useState(true);
	const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<{ projectId: string; side: DropSide } | null>(null);

	function openProject(projectId: string) {
		navigate({ screen: "project", projectId });
	}

	const fetchAllTasks = useCallback(async () => {
		try {
			const results = await api.request.getAllProjectTasks();
			const map = new Map<string, Task[]>();
			for (const { projectId, tasks } of results) {
				map.set(projectId, tasks);
			}
			setTasksByProject(map);
		} catch (err) {
			console.error("Failed to load all project tasks:", err);
		}
		setLoading(false);
	}, []);

	useEffect(() => {
		fetchAllTasks();
	}, [fetchAllTasks]);

	// Stay live: update when tasks change across any project
	useEffect(() => {
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent).detail as { task: Task };
			setTasksByProject((prev) => {
				const next = new Map(prev);
				const projectTasks = [...(next.get(task.projectId) ?? [])];
				const idx = projectTasks.findIndex((t) => t.id === task.id);
				const isActive = ["in-progress", "user-questions", "review-by-ai", "review-by-user", "review-by-colleague"].includes(task.status);
				if (isActive) {
					if (idx >= 0) {
						projectTasks[idx] = task;
					} else {
						projectTasks.push(task);
					}
				} else if (idx >= 0) {
					projectTasks.splice(idx, 1);
				}
				next.set(task.projectId, projectTasks);
				return next;
			});
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, []);

	if (loading) {
		return (
			<div className="h-full flex items-center justify-center">
				<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
			</div>
		);
	}

	const visibleProjects = projects.filter((p) => !p.deleted);
	const totalActive = Array.from(tasksByProject.values()).reduce((sum, tasks) => sum + tasks.length, 0);

	function moveProject(sourceProjectId: string, targetProjectId: string, side: DropSide): string[] {
		const ids = visibleProjects.map((project) => project.id);
		const sourceIndex = ids.indexOf(sourceProjectId);
		if (sourceIndex === -1) return ids;
		ids.splice(sourceIndex, 1);
		const targetIndex = ids.indexOf(targetProjectId);
		if (targetIndex === -1) return visibleProjects.map((project) => project.id);
		ids.splice(side === "after" ? targetIndex + 1 : targetIndex, 0, sourceProjectId);
		return ids;
	}

	function reorderProject(sourceProjectId: string, targetProjectId: string, side: DropSide) {
		if (!onReorderProjects || sourceProjectId === targetProjectId) return;
		const projectIds = moveProject(sourceProjectId, targetProjectId, side);
		void onReorderProjects(projectIds);
	}

	function handleDragOver(event: DragEvent<HTMLDivElement>, projectId: string) {
		if (!draggedProjectId || draggedProjectId === projectId) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const rect = event.currentTarget.getBoundingClientRect();
		const side: DropSide = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
		setDropTarget({ projectId, side });
	}

	function handleDrop(event: DragEvent<HTMLDivElement>, projectId: string) {
		event.preventDefault();
		const sourceProjectId = draggedProjectId ?? event.dataTransfer.getData("text/plain").replace(/^project:/, "");
		const side = dropTarget?.projectId === projectId ? dropTarget.side : "before";
		setDraggedProjectId(null);
		setDropTarget(null);
		reorderProject(sourceProjectId, projectId, side);
	}

	function moveProjectByStep(projectId: string, step: -1 | 1) {
		const index = visibleProjects.findIndex((project) => project.id === projectId);
		const target = visibleProjects[index + step];
		if (!target) return;
		reorderProject(projectId, target.id, step < 0 ? "before" : "after");
	}

	return (
		<div className="h-full overflow-y-auto p-7">
			<div className="max-w-5xl mx-auto space-y-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="text-fg-2 text-sm font-medium">
							{t.plural("dashboard.projectCount", visibleProjects.length)}
						</div>
						{totalActive === 0 && (
							<div className="text-fg-3 text-xs mt-1">{t("activity.noActiveTasks")}</div>
						)}
					</div>
					{onOpenAddProject && (
						<button
							type="button"
							onClick={onOpenAddProject}
							className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all active:scale-95"
						>
							{t("dashboard.addProject")}
						</button>
					)}
				</div>
				{visibleProjects.map((project, index) => {
					const tasks = tasksByProject.get(project.id) ?? [];
					const hasActiveTasks = tasks.length > 0;
					const isDragged = draggedProjectId === project.id;
					const showDropBefore = dropTarget?.projectId === project.id && dropTarget.side === "before";
					const showDropAfter = dropTarget?.projectId === project.id && dropTarget.side === "after";

					// Split into attention tasks (shown individually) and background tasks (summarized)
					const attentionTasks = tasks.filter((t) => ATTENTION_STATUSES.includes(t.status));
					const backgroundTasks = tasks.filter((t) => BACKGROUND_STATUSES.includes(t.status));

					// Build summary segments: "3 in-progress · 2 AI review"
					const summarySegments: { status: TaskStatus; count: number }[] = [];
					for (const status of BACKGROUND_STATUSES) {
						const count = backgroundTasks.filter((t) => t.status === status).length;
						if (count > 0) {
							summarySegments.push({ status, count });
						}
					}

					return (
						<div
							key={project.id}
							className={`relative bg-raised rounded-2xl border border-edge overflow-hidden transition-opacity ${isDragged ? "opacity-60" : ""}`}
							onDragOver={(event) => handleDragOver(event, project.id)}
							onDragLeave={() => setDropTarget((current) => current?.projectId === project.id ? null : current)}
							onDrop={(event) => handleDrop(event, project.id)}
						>
							{showDropBefore && <div className="absolute top-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />}
							{showDropAfter && <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />}
							{/* Project header */}
							<div className={`group flex items-center gap-2 pr-4 ${hasActiveTasks ? "py-3" : "py-2.5"} hover:bg-raised-hover transition-colors`}>
								<div className="pl-3 flex items-center gap-0.5">
									<button
										type="button"
										draggable={!!onReorderProjects}
										onDragStart={(event) => {
											if (!onReorderProjects) return;
											setDraggedProjectId(project.id);
											event.dataTransfer.setData("text/plain", `project:${project.id}`);
											event.dataTransfer.effectAllowed = "move";
										}}
										onDragEnd={() => {
											setDraggedProjectId(null);
											setDropTarget(null);
										}}
										className="text-fg-muted hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated cursor-grab active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
										title={t("dashboard.reorderProject")}
										aria-label={t("dashboard.reorderProject")}
										disabled={!onReorderProjects}
									>
										<span
											className="text-[1rem] leading-none"
											style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
										>
											{"\u{F01DB}"}
										</span>
									</button>
									<button
										type="button"
										onClick={() => moveProjectByStep(project.id, -1)}
										className="hidden md:flex text-fg-muted hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent"
										title={t("dashboard.moveProjectUp")}
										aria-label={t("dashboard.moveProjectUp")}
										disabled={!onReorderProjects || index === 0}
									>
										<span
											className="text-[0.875rem] leading-none"
											style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
										>
											{"\uF062"}
										</span>
									</button>
									<button
										type="button"
										onClick={() => moveProjectByStep(project.id, 1)}
										className="hidden md:flex text-fg-muted hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent"
										title={t("dashboard.moveProjectDown")}
										aria-label={t("dashboard.moveProjectDown")}
										disabled={!onReorderProjects || index === visibleProjects.length - 1}
									>
										<span
											className="text-[0.875rem] leading-none"
											style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
										>
											{"\uF063"}
										</span>
									</button>
								</div>
								<button
									type="button"
									onClick={() => openProject(project.id)}
									className="min-w-0 flex-1 flex items-center gap-3 text-left"
								>
									<div className={`${hasActiveTasks ? "w-8 h-8" : "w-6 h-6"} rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0`}>
										<svg className={`${hasActiveTasks ? "w-4 h-4" : "w-3 h-3"} text-accent`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
										</svg>
									</div>
									<div className="min-w-0 flex-1">
										<div className={`${hasActiveTasks ? "text-fg font-semibold" : "text-fg-3"} text-sm truncate`}>
											{project.name}
										</div>
										<div className="text-fg-3 text-xs mt-0.5 truncate font-mono">
											{project.path}
										</div>
									</div>
								</button>
								<ProjectActionButtons
									project={project}
									navigate={navigate}
									onRemove={onRemoveProject}
									className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
								/>
								<button
									type="button"
									onClick={() => openProject(project.id)}
									className="flex items-center gap-3 pr-1 text-left"
								>
									{hasActiveTasks ? (
										<span className="text-fg-3 text-xs">{t.plural("activity.taskCount", tasks.length)}</span>
									) : (
										<span className="text-fg-muted text-xs">{t("activity.noActiveInProject")}</span>
									)}
									<svg className="w-4 h-4 text-fg-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
									</svg>
								</button>
							</div>

							{hasActiveTasks && (
								<div className="border-t border-edge">
									{/* Attention tasks — shown individually */}
									{attentionTasks.map((task) => (
										<button
											key={task.id}
											onClick={() => navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })}
											className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-raised-hover transition-colors text-left border-b border-edge last:border-b-0"
										>
											<span
												className="w-2.5 h-2.5 rounded-full flex-shrink-0"
												style={{ backgroundColor: statusColors[task.status] }}
												title={getStatusLabel(task.status, t, project)}
											/>
											<span className="text-fg-2 text-sm truncate flex-1">
												{getTaskTitle(task)}
											</span>
											{bellCounts.has(task.id) && (
												<span className="w-2 h-2 rounded-full bg-accent animate-pulse flex-shrink-0" />
											)}
											<span
												className="text-xs flex-shrink-0"
												style={{ color: statusColors[task.status] }}
											>
												{getStatusLabel(task.status, t, project)}
											</span>
											{task.movedAt && (
												<span className="text-fg-muted text-xs flex-shrink-0 w-16 text-right">
													{timeAgo(task.movedAt, t)}
												</span>
											)}
										</button>
									))}

									{/* Background tasks — collapsed summary line */}
									{summarySegments.length > 0 && (
										<div className="flex items-center gap-2 px-5 py-2 border-b border-edge last:border-b-0">
											<div className="flex-1 flex items-center gap-3">
												{summarySegments.map(({ status, count }) => (
													<span key={status} className="flex items-center gap-1.5 text-xs text-fg-3">
														<span
															className="w-2 h-2 rounded-full"
															style={{ backgroundColor: statusColors[status] }}
														/>
														{count} {getStatusLabel(status, t, project).toLowerCase()}
													</span>
												))}
											</div>
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export default ActivityOverview;
