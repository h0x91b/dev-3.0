import { useState, useEffect, useCallback } from "react";
import type { DragEvent } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { comparePriority, getTaskTitle, isBuiltinOpsProject, orderProjectsForDisplay } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { useStatusColors } from "../hooks/useStatusColors";
import ProjectActionButtons from "./ProjectActionButtons";
import BottomSheet from "./BottomSheet";
import HelpSpot from "./HelpSpot";
import PriorityBadge from "./PriorityBadge";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

interface ActivityOverviewProps {
	projects: Project[];
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	onRemoveProject?: (projectId: string) => void | Promise<void>;
	onOpenAddProject?: () => void;
	onReorderProjects?: (projectIds: string[]) => void | Promise<void>;
}

/** Statuses worth their own row — they're waiting on a human (questions, your
 * review, or an open PR review). Tasks parked in a custom column always get a
 * row too, regardless of status (see columnOf below). */
const ATTENTION_STATUSES: TaskStatus[] = ["user-questions", "review-by-user", "review-by-colleague"];

/** Statuses that are "background work" — collapsed into a summary line. */
const BACKGROUND_STATUSES: TaskStatus[] = ["in-progress", "review-by-ai"];

/** Statuses that mean "it's your turn" — surfaced above colleague reviews and
 * given an accent strip on narrow viewports. */
const NEEDS_ME_STATUSES: TaskStatus[] = ["user-questions", "review-by-user"];

/** Narrow-viewport ordering of attention rows so the cap never hides your turn:
 * your questions → your review → colleague PR review → custom-column tasks. */
const ATTENTION_RANK: Partial<Record<TaskStatus, number>> = {
	"user-questions": 0,
	"review-by-user": 1,
	"review-by-colleague": 2,
};

/** Max attention rows shown per project on narrow before the "show more" fold. */
const NARROW_ROW_CAP = 3;

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

/** A full-width, touch-sized (≥44px) row inside the per-project action sheet —
 * the narrow-viewport replacement for the inline icon-button cluster. */
function ActionSheetButton({
	glyph,
	label,
	onClick,
	disabled,
	danger,
}: {
	glyph: string;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	danger?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`flex w-full items-center gap-3 rounded-lg px-2 py-3 min-h-[44px] text-left text-sm transition-colors disabled:opacity-40 ${danger ? "text-danger hover:bg-danger/10" : "text-fg-2 hover:bg-elevated hover:text-fg"}`}
		>
			<span
				className="w-5 flex-shrink-0 text-center text-[1.125rem] leading-none"
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			>
				{glyph}
			</span>
			<span className="flex-1">{label}</span>
		</button>
	);
}

function ActivityOverview({ projects, navigate, bellCounts, onRemoveProject, onOpenAddProject, onReorderProjects }: ActivityOverviewProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [tasksByProject, setTasksByProject] = useState<Map<string, Task[]>>(new Map());
	const [loading, setLoading] = useState(true);
	const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<{ projectId: string; side: DropSide } | null>(null);
	// Narrow viewport: HTML5 drag and the up/down step buttons are unusable on
	// touch, so per-project actions + reorder collapse into a single kebab that
	// opens this action sheet (the project whose id is set here).
	const [actionSheetProjectId, setActionSheetProjectId] = useState<string | null>(null);
	// Narrow viewport: per-project task lists are capped to NARROW_ROW_CAP rows;
	// these are the projects the user has explicitly expanded past the cap.
	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

	function openProject(projectId: string) {
		navigate({ screen: "project", projectId });
	}

	function toggleProjectExpanded(projectId: string) {
		setExpandedProjects((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
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

	// The built-in Operations board is pinned first; ordinary projects keep order.
	const visibleProjects = orderProjectsForDisplay(projects.filter((p) => !p.deleted));
	const hasPinnedBuiltin = visibleProjects.length > 0 && isBuiltinOpsProject(visibleProjects[0]);
	const totalActive = Array.from(tasksByProject.values()).reduce((sum, tasks) => sum + tasks.length, 0);

	// The project backing the open action sheet, with its reorder constraints
	// recomputed live (so "Move up/down" disable as the project hits an edge).
	const sheetProject = actionSheetProjectId
		? visibleProjects.find((p) => p.id === actionSheetProjectId) ?? null
		: null;
	const sheetIndex = sheetProject ? visibleProjects.findIndex((p) => p.id === sheetProject.id) : -1;
	const sheetIsVirtual = sheetProject?.kind === "virtual";
	const sheetIsBuiltin = sheetProject ? isBuiltinOpsProject(sheetProject) : false;
	const sheetCannotMoveUp = sheetIndex <= 0 || (hasPinnedBuiltin && sheetIndex === 1) || !!sheetIsVirtual;
	const sheetCannotMoveDown = sheetIndex === visibleProjects.length - 1 || !!sheetIsVirtual;

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
		<div className="h-full overflow-y-auto p-3 md:p-7">
			<div className="max-w-5xl mx-auto space-y-4">
				<button
					type="button"
					data-hint-id="dashboard-stats"
					data-help-id="dashboard.stats-entry"
					onClick={() => navigate({ screen: "stats" })}
					className="group w-full flex items-center gap-4 rounded-2xl border border-edge bg-raised hover:bg-raised-hover hover:border-edge-active px-5 py-4 transition-all text-left"
				>
					<span className="text-accent text-3xl leading-none shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F04C5}"}</span>
					<div className="flex-1 min-w-0">
						<div className="text-fg font-semibold">{t("stats.cardTitle")}</div>
						<div className="text-fg-3 text-xs mt-0.5 truncate">{t("stats.cardSubtitle")}</div>
					</div>
					<span className="text-fg-muted group-hover:text-accent transition-colors text-lg leading-none shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0142}"}</span>
				</button>
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="flex items-center gap-1.5 text-fg-2 text-sm font-medium">
							{t.plural("dashboard.projectCount", visibleProjects.length)}
							<HelpSpot topicId="dashboard.projects" />
						</div>
						{totalActive === 0 && (
							<div className="text-fg-3 text-xs mt-1">{t("activity.noActiveTasks")}</div>
						)}
					</div>
					{onOpenAddProject && (
						<button
							type="button"
							onClick={onOpenAddProject}
							className="px-4 py-1.5 min-h-[44px] md:min-h-0 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all active:scale-95 flex-shrink-0"
						>
							{t("dashboard.addProject")}
						</button>
					)}
				</div>
				{visibleProjects.map((project, index) => {
					const tasks = tasksByProject.get(project.id) ?? [];
					const hasActiveTasks = tasks.length > 0;
					const isDragged = draggedProjectId === project.id;
					const isBuiltinOps = isBuiltinOpsProject(project);
					// Virtual boards (builtin and user-created) cannot be reordered:
					// reorderProjects only persists git project order; dragging a virtual
					// board would silently snap back after the API call. The project right
					// below the pinned builtin also cannot move above the pin.
					const cannotReorder = project.kind === "virtual";
					const cannotMoveUp = index === 0 || (hasPinnedBuiltin && index === 1) || cannotReorder;
					const showDropBefore = dropTarget?.projectId === project.id && dropTarget.side === "before";
					const showDropAfter = dropTarget?.projectId === project.id && dropTarget.side === "after";

					// A task is "in" a custom column only when its customColumnId still
					// resolves to a live column; a dangling id (deleted column) falls back
					// to status-based bucketing, mirroring the kanban (PR #737).
					const customColumnById = new Map((project.customColumns ?? []).map((c) => [c.id, c] as const));
					const columnOf = (task: Task) =>
						task.customColumnId ? customColumnById.get(task.customColumnId) ?? null : null;

					// Rows shown individually: attention statuses (questions / your review /
					// PR review) plus any task parked in a custom column. Custom-column
					// tasks carry the column's identity, not their underlying status, and
					// are never collapsed into the summary line below.
					const rowTasks = tasks.filter(
						(task) => columnOf(task) !== null || ATTENTION_STATUSES.includes(task.status),
					);
					const backgroundTasks = tasks.filter(
						(task) => columnOf(task) === null && BACKGROUND_STATUSES.includes(task.status),
					);

					// Build summary segments: "3 in-progress · 2 AI review"
					const summarySegments: { status: TaskStatus; count: number }[] = [];
					for (const status of BACKGROUND_STATUSES) {
						const count = backgroundTasks.filter((t) => t.status === status).length;
						if (count > 0) {
							summarySegments.push({ status, count });
						}
					}

					// Order every visible row by priority first. On narrow viewports, keep
					// "your turn" ahead of colleague reviews within the same priority band,
					// then cap the list to NARROW_ROW_CAP behind a "show more" fold.
					const rankOf = (task: Task) =>
						columnOf(task) !== null ? 3 : ATTENTION_RANK[task.status] ?? 3;
					const orderedRowTasks = [...rowTasks].sort((a, b) => {
						const byPriority = comparePriority(a.priority, b.priority);
						if (byPriority !== 0) return byPriority;
						return narrow ? rankOf(a) - rankOf(b) : 0;
					});
					const isExpanded = expandedProjects.has(project.id);
					const canCollapse = narrow && orderedRowTasks.length > NARROW_ROW_CAP;
					const visibleRowTasks =
						canCollapse && !isExpanded ? orderedRowTasks.slice(0, NARROW_ROW_CAP) : orderedRowTasks;
					const hiddenRowCount = orderedRowTasks.length - visibleRowTasks.length;

					return (
						<div
							key={project.id}
							data-help-id="dashboard.project-row"
							className={`relative bg-raised rounded-2xl border border-edge overflow-hidden transition-opacity ${isDragged ? "opacity-60" : ""}`}
							onDragOver={(event) => handleDragOver(event, project.id)}
							onDragLeave={() => setDropTarget((current) => current?.projectId === project.id ? null : current)}
							onDrop={(event) => handleDrop(event, project.id)}
						>
							{showDropBefore && <div className="absolute top-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />}
							{showDropAfter && <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />}
							{/* Project header */}
							<div className={`group flex items-center gap-2 pl-3 md:pl-0 pr-2 md:pr-4 ${hasActiveTasks ? "py-3" : "py-2.5"} hover:bg-raised-hover transition-colors`}>
								{/* Reorder cluster — desktop only. On touch, drag and the
								    step buttons are unusable; reorder lives in the action sheet. */}
								<div className="hidden md:flex pl-3 items-center gap-0.5">
									<button
										type="button"
										draggable={!!onReorderProjects && !cannotReorder}
										onDragStart={(event) => {
											if (!onReorderProjects || cannotReorder) return;
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
										disabled={!onReorderProjects || cannotReorder}
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
										disabled={!onReorderProjects || cannotMoveUp}
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
										disabled={!onReorderProjects || index === visibleProjects.length - 1 || cannotReorder}
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
									data-hint-id={`project:${project.id}`}
									onClick={() => openProject(project.id)}
									className="min-w-0 flex-1 flex items-center gap-3 text-left"
								>
									<div className={`${hasActiveTasks ? "w-8 h-8" : "w-6 h-6"} rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0`}>
										<svg className={`${hasActiveTasks ? "w-4 h-4" : "w-3 h-3"} text-accent`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
										</svg>
									</div>
									<div className="min-w-0 flex-1">
										<div className={`${hasActiveTasks ? "text-fg font-semibold" : "text-fg-3"} text-sm truncate flex items-center gap-2`}>
											{isBuiltinOps && (
												<span className="text-accent flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
											)}
											<span className="truncate">{isBuiltinOps ? t("ops.boardName") : project.name}</span>
											{project.kind === "virtual" && (
												<span className="px-1.5 py-0.5 rounded bg-raised text-fg-3 text-[0.625rem] font-medium flex items-center gap-1 flex-shrink-0">
													<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
													{isBuiltinOps ? t("ops.badgeSystem") : t("ops.badge")}
												</span>
											)}
											{isBuiltinOps && (
												<span className="text-fg-muted text-[0.5625rem] font-mono border border-edge rounded px-1 py-0.5 leading-none flex-shrink-0">⌘0</span>
											)}
										</div>
										{/* Subtitle (path / virtual hint) is dead weight on a phone —
										    name + badge already identify the board. Desktop only. */}
										{project.kind === "virtual" ? (
											<div className="hidden md:block text-fg-3 text-xs mt-0.5 truncate">{t("ops.tileSubtitle")}</div>
										) : (
											<div className="hidden md:block text-fg-3 text-xs mt-0.5 truncate font-mono streamer-private">{project.path}</div>
										)}
									</div>
								</button>
								{/* Desktop: hover-revealed inline icon cluster. */}
								<div className="hidden md:flex">
									<ProjectActionButtons
										project={project}
										navigate={navigate}
										onRemove={onRemoveProject}
										className="md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
									/>
								</div>
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
									{/* Chevron is redundant on narrow — the name + count already
									    navigate, so it only crowds the row end where the kebab sits. */}
									<svg className="hidden md:block w-4 h-4 text-fg-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
									</svg>
								</button>
								{/* Narrow: a single kebab folds every per-project action + reorder
								    into a bottom sheet. Rendered last so it sits at the true row end. */}
								{narrow && (
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											setActionSheetProjectId(project.id);
										}}
										className="flex h-11 w-11 items-center justify-center rounded-lg text-fg-3 hover:text-fg hover:bg-elevated transition-colors flex-shrink-0"
										title={t("activity.projectActions")}
										aria-label={t("activity.projectActions")}
										aria-haspopup="dialog"
									>
										<span className="text-[1.125rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F01D9}"}</span>
									</button>
								)}
							</div>

							{hasActiveTasks && (
								<div className="border-t border-edge">
									{/* Attention + custom-column tasks — shown individually. On narrow
									    each row stacks (title on its own line, meta below) so the title
									    is readable instead of squeezed by the status + time cluster. */}
									{visibleRowTasks.map((task) => {
										const col = columnOf(task);
										const rowColor = col ? col.color : statusColors[task.status];
										const rowLabel = col ? col.name : getStatusLabel(task.status, t, project);
										const needsMe = !col && NEEDS_ME_STATUSES.includes(task.status);
										return (
										<button
											key={task.id}
											data-hint-id={`task:${task.id}`}
											onClick={() => navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })}
											className="relative w-full flex items-start md:items-center gap-3 px-4 md:px-5 py-3 md:py-2.5 min-h-[44px] hover:bg-raised-hover transition-colors text-left border-b border-edge last:border-b-0"
										>
											{/* "Your turn" accent strip — narrow only (keeps desktop intact). */}
											{narrow && needsMe && (
												<span
													className="absolute left-0 top-0 bottom-0 w-0.5"
													style={{ backgroundColor: rowColor }}
												/>
											)}
											{/* Priority replaces the status dot in the leading marker slot. */}
											<PriorityBadge
												priority={task.priority}
												className={`flex-shrink-0 ${narrow ? "mt-0.5" : ""}`}
											/>
											<span className="min-w-0 flex-1 flex flex-col md:flex-row md:items-center gap-0.5 md:gap-3">
												<span
													className={`text-fg-2 text-sm min-w-0 md:flex-1 ${narrow ? "line-clamp-2" : "truncate"}`}
												>
													{getTaskTitle(task)}
												</span>
												<span className="flex items-center gap-2 md:gap-3 flex-shrink-0">
													{bellCounts.has(task.id) && (
														<span className="w-2 h-2 rounded-full bg-accent animate-pulse flex-shrink-0" />
													)}
													<span className="text-xs flex-shrink-0" style={{ color: rowColor }}>
														{rowLabel}
													</span>
													{task.movedAt && (
														<span className="text-fg-muted text-xs flex-shrink-0 md:w-16 md:text-right">
															{timeAgo(task.movedAt, t)}
														</span>
													)}
												</span>
											</span>
										</button>
										);
									})}

									{/* Narrow: fold the long tail behind a touch-sized toggle. */}
									{canCollapse && (
										<button
											type="button"
											onClick={() => toggleProjectExpanded(project.id)}
											aria-expanded={isExpanded}
											className="w-full flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-xs text-fg-3 hover:text-fg hover:bg-raised-hover transition-colors border-b border-edge last:border-b-0"
										>
											{isExpanded
												? t("activity.showFewerTasks")
												: t.plural("activity.showMoreTasks", hiddenRowCount)}
										</button>
									)}

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

				{/* Narrow-viewport per-project action sheet — the touch surface for
				    actions that are hover-only / drag-only on desktop. */}
				{narrow && sheetProject && (
					<BottomSheet
						open={!!sheetProject}
						onClose={() => setActionSheetProjectId(null)}
						title={sheetIsBuiltin ? t("ops.boardName") : sheetProject.name}
						ariaLabel={t("activity.projectActions")}
						testId="activity-project-action-sheet"
					>
						<div className="flex flex-col">
							<ActionSheetButton
								glyph={""}
								label={t("activity.openBoard")}
								onClick={() => {
									setActionSheetProjectId(null);
									openProject(sheetProject.id);
								}}
							/>
							<ActionSheetButton
								glyph={"\u{F0493}"}
								label={t("header.projectSettings")}
								onClick={() => {
									setActionSheetProjectId(null);
									navigate({ screen: "project-settings", projectId: sheetProject.id });
								}}
							/>
							{!sheetIsVirtual && (
								<ActionSheetButton
									glyph={"\u{F115}"}
									label={t("dashboard.openInFinder")}
									onClick={() => {
										setActionSheetProjectId(null);
										api.request.openFolder({ path: sheetProject.path }).catch(() => {});
									}}
								/>
							)}
							{!sheetIsVirtual && (
								<ActionSheetButton
									glyph={"\u{F489}"}
									label={t("projectTerminal.tooltip")}
									onClick={() => {
										setActionSheetProjectId(null);
										navigate({ screen: "project-terminal", projectId: sheetProject.id });
									}}
								/>
							)}
							{onReorderProjects && (
								<>
									<ActionSheetButton
										glyph={"\u{F062}"}
										label={t("dashboard.moveProjectUp")}
										disabled={sheetCannotMoveUp}
										onClick={() => moveProjectByStep(sheetProject.id, -1)}
									/>
									<ActionSheetButton
										glyph={"\u{F063}"}
										label={t("dashboard.moveProjectDown")}
										disabled={sheetCannotMoveDown}
										onClick={() => moveProjectByStep(sheetProject.id, 1)}
									/>
								</>
							)}
							{onRemoveProject && !sheetIsBuiltin && (
								<ActionSheetButton
									glyph={"\u{F0A79}"}
									label={t("dashboard.remove")}
									danger
									onClick={() => {
										setActionSheetProjectId(null);
										void onRemoveProject(sheetProject.id);
									}}
								/>
							)}
						</div>
					</BottomSheet>
				)}
			</div>
		</div>
	);
}

export default ActivityOverview;
