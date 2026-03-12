import { useState, useEffect, useCallback } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT, statusKey } from "../i18n";
import { useStatusColors } from "../hooks/useStatusColors";

interface ActivityOverviewProps {
	projects: Project[];
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
}

/** Statuses that require the user's attention — shown as individual task rows. */
const ATTENTION_STATUSES: TaskStatus[] = ["user-questions", "review-by-user"];

/** Statuses that are "background work" — collapsed into a summary line. */
const BACKGROUND_STATUSES: TaskStatus[] = ["in-progress", "review-by-ai", "review-by-colleague"];

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

function ActivityOverview({ projects, navigate, bellCounts }: ActivityOverviewProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const [tasksByProject, setTasksByProject] = useState<Map<string, Task[]>>(new Map());
	const [loading, setLoading] = useState(true);

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

	const sortedProjects = projects
		.filter((p) => !p.deleted)
		.sort((a, b) => {
			const aCount = tasksByProject.get(a.id)?.length ?? 0;
			const bCount = tasksByProject.get(b.id)?.length ?? 0;
			// Projects with active tasks first, then by count descending
			if (aCount === 0 && bCount > 0) return 1;
			if (aCount > 0 && bCount === 0) return -1;
			return bCount - aCount;
		});
	const totalActive = Array.from(tasksByProject.values()).reduce((sum, tasks) => sum + tasks.length, 0);

	if (totalActive === 0) {
		return (
			<div className="h-full flex flex-col items-center justify-center">
				<p className="text-fg-3 text-sm">{t("activity.noActiveTasks")}</p>
			</div>
		);
	}

	return (
		<div className="h-full overflow-y-auto p-7">
			<div className="max-w-3xl mx-auto space-y-4">
				{sortedProjects.map((project) => {
					const tasks = tasksByProject.get(project.id) ?? [];
					const hasActiveTasks = tasks.length > 0;

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
						<div key={project.id} className="bg-raised rounded-2xl border border-edge overflow-hidden">
							{/* Project header */}
							<button
								onClick={() => navigate({ screen: "project", projectId: project.id })}
								className={`w-full flex items-center gap-3 px-5 ${hasActiveTasks ? "py-3" : "py-2.5"} hover:bg-raised-hover transition-colors text-left`}
							>
								<div className={`${hasActiveTasks ? "w-8 h-8" : "w-6 h-6"} rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0`}>
									<svg className={`${hasActiveTasks ? "w-4 h-4" : "w-3 h-3"} text-accent`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
									</svg>
								</div>
								<span className={`${hasActiveTasks ? "text-fg font-semibold" : "text-fg-3"} text-sm truncate flex-1`}>{project.name}</span>
								{hasActiveTasks ? (
									<span className="text-fg-3 text-xs">{t.plural("activity.taskCount", tasks.length)}</span>
								) : (
									<span className="text-fg-muted text-xs">{t("activity.noActiveInProject")}</span>
								)}
								<svg className="w-4 h-4 text-fg-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
								</svg>
							</button>

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
												title={t(statusKey(task.status))}
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
												{t(statusKey(task.status))}
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
														{count} {t(statusKey(status)).toLowerCase()}
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
