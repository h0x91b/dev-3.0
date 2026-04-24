import { useState, useRef, useEffect, useMemo, useCallback, type Dispatch } from "react";
import type { CodingAgent, PortInfo, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { useTerminalPreview } from "../hooks/useTerminalPreview";
import { api } from "../rpc";
import type { AppAction, Route } from "../state";
import { useT } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { matchesSearchQuery } from "../utils/taskSearch";
import LabelChip from "./LabelChip";
import TerminalPreviewPopover from "./TerminalPreviewPopover";
import AgentLauncherBadge from "./AgentLauncherBadge";
import VariantDots from "./VariantDots";
import { getTaskAgentMeta } from "../utils/taskAgentMeta";

type SidebarScope = "project" | "global";
const LS_SIDEBAR_SCOPE = "dev3-sidebar-scope";

function readScope(): SidebarScope {
	try {
		const v = localStorage.getItem(LS_SIDEBAR_SCOPE);
		if (v === "global" || v === "project") return v;
	} catch { /* ignore */ }
	return "project";
}

function writeScope(scope: SidebarScope) {
	try {
		localStorage.setItem(LS_SIDEBAR_SCOPE, scope);
	} catch { /* ignore */ }
}

interface ActiveTasksSidebarProps {
	project: Project;
	tasks: Task[];
	allProjects?: Project[];
	activeTaskId?: string;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	agents: CodingAgent[];
	bellCounts: Map<string, number>;
	taskPorts: Map<string, PortInfo[]>;
	onSwitchToBoard: () => void;
	disableGlobalFindShortcut?: boolean;
}

/** Status display order: most actionable for the user first */
const STATUS_ORDER: TaskStatus[] = [
	"review-by-user",
	"review-by-colleague",
	"user-questions",
	"in-progress",
	"review-by-ai",
];

function ActiveTasksSidebar({
	project,
	tasks,
	allProjects,
	activeTaskId,
	navigate,
	agents,
	bellCounts,
	taskPorts,
	onSwitchToBoard,
	disableGlobalFindShortcut = false,
}: ActiveTasksSidebarProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const preview = useTerminalPreview();
	const [searchQuery, setSearchQuery] = useState("");
	const [scope, setScopeState] = useState<SidebarScope>(readScope);
	const [globalTasks, setGlobalTasks] = useState<Task[]>([]);
	const [globalLoading, setGlobalLoading] = useState(false);
	const searchRef = useRef<HTMLInputElement>(null);

	const setScope = useCallback((next: SidebarScope) => {
		setScopeState(next);
		writeScope(next);
	}, []);

	// Ctrl/Cmd+F focuses the search input when sidebar is visible
	useEffect(() => {
		if (disableGlobalFindShortcut) {
			return;
		}

		function handleKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "f") {
				e.preventDefault();
				searchRef.current?.focus();
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [disableGlobalFindShortcut]);

	// Fetch active tasks from all projects when in global scope.
	useEffect(() => {
		if (scope !== "global") return;
		let cancelled = false;
		setGlobalLoading(true);
		(async () => {
			try {
				const results = await api.request.getAllProjectTasks();
				if (cancelled) return;
				const flat: Task[] = [];
				for (const { tasks: projectTasks } of results) {
					for (const task of projectTasks) flat.push(task);
				}
				setGlobalTasks(flat);
			} catch (err) {
				if (!cancelled) {
					console.error("Failed to load global active tasks:", err);
				}
			} finally {
				if (!cancelled) setGlobalLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [scope]);

	// Keep global tasks live across all projects.
	useEffect(() => {
		if (scope !== "global") return;
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent).detail as { task: Task };
			setGlobalTasks((prev) => {
				const idx = prev.findIndex((t) => t.id === task.id);
				const isActive = ACTIVE_STATUSES.includes(task.status);
				if (isActive) {
					if (idx >= 0) {
						const next = prev.slice();
						next[idx] = task;
						return next;
					}
					return [...prev, task];
				}
				if (idx >= 0) {
					const next = prev.slice();
					next.splice(idx, 1);
					return next;
				}
				return prev;
			});
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, [scope]);

	const sourceTasks = scope === "global" ? globalTasks : tasks;

	let activeTasks = sourceTasks.filter((task) => ACTIVE_STATUSES.includes(task.status));
	if (searchQuery.trim()) {
		activeTasks = activeTasks.filter((task) => matchesSearchQuery(task, searchQuery));
	}

	const projectById = useMemo(() => {
		const map = new Map<string, Project>();
		if (allProjects) {
			for (const p of allProjects) map.set(p.id, p);
		}
		map.set(project.id, project);
		return map;
	}, [allProjects, project]);

	const siblingMap = useMemo(() => {
		const map = new Map<string, Task[]>();
		for (const task of sourceTasks) {
			if (!task.groupId) continue;
			const existing = map.get(task.groupId);
			if (existing) {
				existing.push(task);
			} else {
				map.set(task.groupId, [task]);
			}
		}
		return map;
	}, [sourceTasks]);

	// Group by status in display order
	const grouped = STATUS_ORDER
		.map((status) => ({
			status,
			tasks: activeTasks.filter((task) => task.status === status),
		}))
		.filter((g) => g.tasks.length > 0);

	function handleTaskClick(task: Task) {
		preview.close();
		const targetProjectId = task.projectId || project.id;
		if (task.id === activeTaskId && targetProjectId === project.id) {
			navigate({ screen: "project", projectId: project.id });
		} else {
			navigate({
				screen: "project",
				projectId: targetProjectId,
				activeTaskId: task.id,
			});
		}
	}

	const projectLabels = project.labels ?? [];

	return (
		<div className="h-full flex flex-col bg-base">
			{/* Header */}
			<div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-edge flex-shrink-0">
				<span className="text-xs font-semibold text-fg-2 uppercase tracking-wider truncate">
					{t("sidebar.activeTasks")}
				</span>
				<div className="flex items-center gap-1.5 flex-shrink-0 h-5">
					<div className="inline-flex items-center gap-px" aria-label={t("sidebar.scopeToggleTitle")}>
						<button
							type="button"
							onClick={() => setScope("project")}
							title={t("sidebar.scopeProject")}
							className={`inline-flex items-center justify-center h-5 w-5 leading-none transition-colors ${
								scope === "project" ? "text-fg" : "text-fg-muted hover:text-fg-2"
							}`}
							data-testid="sidebar-scope-project"
						>
							{/* Nerd Font: nf-fa-folder_open (U+F07C) */}
							<span
								className="text-sm leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\uF07C"}
							</span>
						</button>
						<button
							type="button"
							role="switch"
							aria-checked={scope === "global"}
							onClick={() => setScope(scope === "global" ? "project" : "global")}
							title={t("sidebar.scopeToggleTitle")}
							className={`relative inline-flex items-center h-4 w-8 rounded-full transition-colors ${
								scope === "global" ? "bg-accent" : "bg-fg/20"
							}`}
							data-testid="sidebar-scope-toggle"
						>
							<span
								className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow transform transition-transform ${
									scope === "global" ? "translate-x-[1.125rem]" : "translate-x-0.5"
								}`}
							/>
							<span className="sr-only">
								{scope === "global" ? t("sidebar.scopeGlobal") : t("sidebar.scopeProject")}
							</span>
						</button>
						<button
							type="button"
							onClick={() => setScope("global")}
							title={t("sidebar.scopeGlobal")}
							className={`inline-flex items-center justify-center h-5 w-5 leading-none transition-colors ${
								scope === "global" ? "text-fg" : "text-fg-muted hover:text-fg-2"
							}`}
							data-testid="sidebar-scope-global"
						>
							{/* Nerd Font: nf-cod-globe (U+EB01) */}
							<span
								className="text-sm leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\uEB01"}
							</span>
						</button>
					</div>
					<button
						onClick={onSwitchToBoard}
						className="inline-flex items-center justify-center h-5 w-5 text-fg-muted hover:text-accent transition-colors rounded hover:bg-fg/5"
						title={t("sidebar.switchToBoard")}
					>
						{/* Nerd Font: fa-columns (U+F0DB) */}
						<span
							className="text-sm leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{"\uF0DB"}
						</span>
					</button>
				</div>
			</div>

			{/* Search input */}
			<div className="px-2 py-1.5 border-b border-edge flex-shrink-0">
				<div className="relative">
					<svg
						className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-3 pointer-events-none"
						fill="none"
						viewBox="0 0 24 24"
						strokeWidth={2}
						stroke="currentColor"
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
					</svg>
					<input
						ref={searchRef}
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								setSearchQuery("");
								searchRef.current?.blur();
							}
						}}
						placeholder={t("sidebar.searchPlaceholder")}
						className="w-full pl-6 pr-5 py-1 text-xs bg-base border border-edge rounded-md text-fg placeholder:text-fg-muted focus:outline-none focus:border-edge-active transition-colors"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg text-xs leading-none"
						>
							×
						</button>
					)}
				</div>
			</div>

			{/* Task list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{scope === "global" && globalLoading && grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{t("sidebar.globalLoading")}
					</div>
				) : grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{searchQuery.trim() ? t("sidebar.noSearchResults") : t("sidebar.noActiveTasks")}
					</div>
				) : (
					grouped.map(({ status, tasks: groupTasks }, groupIdx) => (
						<div key={status}>
							{/* Solid separator between status groups */}
							{groupIdx > 0 && (
								<div className="mx-3 border-t border-edge" />
							)}

							{/* Status group header */}
							<div className="px-3 py-1.5 flex items-center gap-2 sticky top-0 bg-base/95 backdrop-blur-sm z-10">
								<div
									className="w-2 h-2 rounded-full flex-shrink-0"
									style={{ background: statusColors[status] }}
								/>
								<span className="text-[0.625rem] font-semibold text-fg-3 uppercase tracking-wider">
									{getStatusLabel(status, t, project)}
								</span>
								<span className="text-[0.625rem] text-fg-muted">
									{groupTasks.length}
								</span>
							</div>

							{/* Tasks in this status */}
							{groupTasks.map((task, idx) => {
								const isActive = task.id === activeTaskId && task.projectId === project.id;
								const bellCount = bellCounts.get(task.id) ?? 0;
								const displayTitle = getTaskTitle(task);
								const { agent, configLabel } = getTaskAgentMeta(task, agents);
								const taskLabelIds = task.labelIds ?? [];
								const taskProject = projectById.get(task.projectId);
								const labelsPool = (taskProject?.labels ?? projectLabels) as typeof projectLabels;
								const assignedLabels = taskLabelIds
									.map((id) => labelsPool.find((l) => l.id === id))
									.filter(Boolean) as typeof projectLabels;
								const groupMembers = task.groupId ? siblingMap.get(task.groupId) ?? [task] : [task];
								const agentSummary = [agent?.name, configLabel].filter(Boolean).join(" · ");
								const showProjectBadge = scope === "global" && task.projectId !== project.id;
								const projectBadgeName = taskProject?.name ?? t("sidebar.unknownProject");

								return (
									<div key={task.id}>
										{/* Dashed separator between tasks within the same group */}
										{idx > 0 && (
											<div className="mx-3 border-t border-dashed border-edge" />
										)}
										<button
											onClick={() => handleTaskClick(task)}
											onMouseEnter={(e) => preview.handlers.onMouseEnter(task.id, e.currentTarget)}
											onMouseLeave={preview.handlers.onMouseLeave}
											className={`w-full text-left px-3 py-2 transition-all border-l-2 relative ${
												isActive
													? "bg-accent/10 border-accent"
													: "border-transparent hover:bg-elevated-hover"
											}`}
										>
											{/* Bell badge */}
											{bellCount > 0 && (
												<div
													className="absolute top-1 right-2 min-w-[1rem] h-4 flex items-center justify-center px-1 rounded-full bg-red-500 shadow-sm shadow-red-500/40"
													title={t("task.bellTooltip")}
												>
													<span className="text-[0.5625rem] font-bold text-white leading-none">
														{bellCount > 9 ? "9+" : bellCount}
													</span>
												</div>
											)}

												<div className="mb-1 flex items-center gap-1.5 min-w-0">
													{agent && <AgentLauncherBadge agent={agent} size={14} />}
													<div
														className={`min-w-0 flex-1 truncate text-[0.625rem] font-medium ${
															isActive ? "text-fg" : "text-fg-2"
														}`}
														title={agentSummary || undefined}
													>
														{agentSummary || `#${task.seq}`}
													</div>
													{task.variantIndex !== null && (
														<VariantDots
															groupMembers={groupMembers}
															currentTaskId={task.id}
															statusColors={statusColors}
															testId={`variant-indicator-${task.id}`}
														/>
													)}
												</div>

												{/* Project badge (global scope only) */}
												{showProjectBadge && (
													<div
														className="mb-1 inline-flex items-center gap-1 max-w-full text-[0.5625rem] text-fg-3 bg-fg/5 rounded px-1 py-[1px]"
														title={projectBadgeName}
														data-testid={`sidebar-project-badge-${task.id}`}
													>
														<span
															aria-hidden
															style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
															className="leading-none"
														>
															{"\uEB01"}
														</span>
														<span className="truncate">{projectBadgeName}</span>
													</div>
												)}

												{/* Title */}
												<div className={`text-xs leading-snug break-words ${
													isActive ? "text-fg font-medium" : "text-fg-2"
												}`}>
													{displayTitle}
												</div>

												<div className="mt-1 flex items-center gap-1 min-w-0">
													<div className="text-[0.5625rem] text-fg-muted font-mono shrink-0">
														#{task.seq}
													</div>
													{assignedLabels.length > 0 && (
														<div className="flex flex-wrap gap-0.5 min-w-0">
															{assignedLabels.map((label) => (
																<LabelChip
																	key={label.id}
																	label={label}
																	size="xs"
																/>
															))}
														</div>
													)}
												</div>

												{/* Port indicators */}
												{(() => {
													const ports = taskPorts.get(task.id);
													if (!ports || ports.length === 0) return null;
													return (
														<div className="flex flex-wrap gap-1 mt-1">
															{ports.map((p) => (
																<span
																	key={p.port}
																	className="inline-flex items-center gap-1 text-[0.5625rem] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded"
																	title={`${p.processName} (PID ${p.pid})`}
																	onClick={(e) => {
																		e.stopPropagation();
																		window.open(`http://localhost:${p.port}`, "_blank");
																	}}
																>
																	<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF0AC"}</span>
																	:{p.port}
																</span>
															))}
														</div>
													);
												})()}
										</button>
									</div>
								);
							})}
						</div>
					))
				)}
			</div>

			{(() => {
				const hoveredTask = preview.state.activeTaskId
					? tasks.find((t) => t.id === preview.state.activeTaskId)
					: null;
				return (
					<TerminalPreviewPopover
						{...preview.state}
						taskId={hoveredTask?.id ?? null}
						projectId={project.id}
						overview={hoveredTask?.overview ?? null}
						description={hoveredTask?.description ?? null}
					/>
				);
			})()}
		</div>
	);
}

export default ActiveTasksSidebar;
