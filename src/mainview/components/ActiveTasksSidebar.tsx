import { useState, useRef, useEffect, useMemo, useCallback, type Dispatch } from "react";
import type { CodingAgent, CustomColumn, PortInfo, Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { useTerminalPreview } from "../hooks/useTerminalPreview";
import { api } from "../rpc";
import type { AppAction, Route } from "../state";
import { useT, useLocale } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { matchesSearchQuery } from "../utils/taskSearch";
import { ageParts, compactAge, type AgeUnit } from "../utils/statusAge";
import LabelChip from "./LabelChip";
import TipCard from "./TipCard";
import { useTipRotation } from "../hooks/useTipRotation";
import TerminalPreviewPopover from "./TerminalPreviewPopover";
import AgentLauncherBadge from "./AgentLauncherBadge";
import VariantDots from "./VariantDots";
import { getTaskAgentMeta } from "../utils/taskAgentMeta";

type SidebarScope = "project" | "global" | "attention";
const LS_SIDEBAR_SCOPE = "dev3-sidebar-scope";

/** Build a translucent fill from a "#rrggbb" status color for subtle tints. */
function statusTint(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Statuses that require the user's attention — the "attention" scope shows only these. */
const ATTENTION_STATUSES: TaskStatus[] = ["user-questions", "review-by-user"];

function readScope(): SidebarScope {
	try {
		const v = localStorage.getItem(LS_SIDEBAR_SCOPE);
		if (v === "global" || v === "project" || v === "attention") return v;
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
	bellReasons?: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
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

/**
 * Within-group order for the sidebar: oldest-first by `movedAt` (longest-waiting
 * task on top). The sidebar is a work queue, not a feed — the oldest task is the
 * most at risk of being forgotten, and for review/questions groups it is the one
 * the agent has been blocked on longest. Tasks without `movedAt` sink to the
 * bottom; `seq` is a stable tiebreak. See UX_DECISIONS 2026-06-22.
 */
function byMovedAtOldestFirst(a: Task, b: Task): number {
	const aTime = a.movedAt ? new Date(a.movedAt).getTime() : Infinity;
	const bTime = b.movedAt ? new Date(b.movedAt).getTime() : Infinity;
	if (aTime !== bTime) return aTime - bTime;
	return a.seq - b.seq;
}

/** Maps the single most-significant age unit to its verbose i18n key. */
const AGE_UNIT_KEY: Record<AgeUnit, string> = {
	s: "activity.secondsAgo",
	m: "activity.minutesAgo",
	h: "activity.hoursAgo",
	d: "activity.daysAgo",
	M: "activity.monthsAgo",
	y: "activity.yearsAgo",
};

function ActiveTasksSidebar({
	project,
	tasks,
	allProjects,
	activeTaskId,
	navigate,
	agents,
	bellCounts,
	bellReasons,
	taskPorts,
	disableGlobalFindShortcut = false,
}: ActiveTasksSidebarProps) {
	const t = useT();
	const [locale] = useLocale();
	const statusColors = useStatusColors();
	const preview = useTerminalPreview();
	// Feature-discovery tips in the task view (terminal context leads the rotation).
	const { tip: currentTip, tipState, applyTipState } = useTipRotation("terminal");
	const [searchQuery, setSearchQuery] = useState("");
	// Re-render once per second so the status-age badges stay live.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
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

	// Always fetch global tasks (for the attention badge) and re-fetch when
	// switching into global/attention scope. Loading spinner only shows in
	// scoped views so project-scope mounts are silent.
	useEffect(() => {
		let cancelled = false;
		const isScoped = scope === "global" || scope === "attention";
		if (isScoped) setGlobalLoading(true);
		(async () => {
			try {
				const results = await api.request.getAllProjectTasks({});
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
				if (!cancelled && isScoped) setGlobalLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [scope]);

	// Keep global tasks live across all projects.
	useEffect(() => {
		if (scope !== "global" && scope !== "attention") return;
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

	const sourceTasks = (scope === "global" || scope === "attention") ? globalTasks : tasks;

	// A task needs attention if it is in an attention status, OR it is a
	// `review-by-colleague` (PR Review) task that currently has a live bell — the
	// background PR poller raises the bell on a CI/review signal, and opening the
	// task clears it, so a signalled PR surfaces here until it is read.
	const isAttentionTask = useCallback(
		(task: Task) =>
			ATTENTION_STATUSES.includes(task.status) ||
			(task.status === "review-by-colleague" && (bellCounts.get(task.id) ?? 0) > 0),
		[bellCounts],
	);

	// Count of attention tasks across all available data (global when loaded, else project).
	const attentionCount = useMemo(() => {
		const pool = globalTasks.length > 0 ? globalTasks : tasks;
		return pool.filter(isAttentionTask).length;
	}, [globalTasks, tasks, isAttentionTask]);

	let activeTasks = sourceTasks.filter((task) => ACTIVE_STATUSES.includes(task.status));
	if (scope === "attention") {
		activeTasks = activeTasks.filter(isAttentionTask);
		// Sort oldest-first by movedAt (status-change timestamp) so the
		// longest-waiting task is always at the top.
		activeTasks = activeTasks.slice().sort((a, b) => {
			const aTime = a.movedAt ? new Date(a.movedAt).getTime() : 0;
			const bTime = b.movedAt ? new Date(b.movedAt).getTime() : 0;
			return aTime - bTime;
		});
	}
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

	// Resolves a task's display color: its custom-column color when the task is
	// parked in a custom column, otherwise its built-in status hue. Mirrors the
	// kanban, where a custom-column task carries the column's color, not its
	// underlying status color.
	const taskColor = useCallback(
		(task: Task): string => {
			if (task.customColumnId) {
				const col = projectById
					.get(task.projectId)
					?.customColumns?.find((c) => c.id === task.customColumnId);
				if (col) return col.color;
			}
			return statusColors[task.status];
		},
		[projectById, statusColors],
	);

	// A rendered group: either a built-in status column or a custom column.
	// `busy` drives the header spinner (agent actively working).
	interface SidebarGroup {
		key: string;
		label: string;
		color: string;
		busy: boolean;
		tasks: Task[];
	}

	// In attention mode, render a single flat list sorted oldest-first by movedAt;
	// grouping would reorder tasks by status, defeating age ordering.
	// Otherwise mirror the kanban: built-in status columns exclude tasks parked
	// in a custom column, and each custom column becomes its own group.
	let grouped: SidebarGroup[];
	if (scope === "attention") {
		grouped = activeTasks.length > 0
			? [{ key: "attention", label: "", color: statusColors["user-questions"], busy: false, tasks: activeTasks }]
			: [];
	} else {
		const builtinGroups: SidebarGroup[] = STATUS_ORDER
			.map((status) => ({
				key: status,
				label: getStatusLabel(status, t, project),
				color: statusColors[status],
				busy: status === "in-progress" || status === "review-by-ai",
				tasks: activeTasks
					.filter((task) => task.status === status && !task.customColumnId)
					.sort(byMovedAtOldestFirst),
			}))
			.filter((g) => g.tasks.length > 0);

		// Custom-column groups, ordered by each owning project's customColumns
		// order. Scan all projects in global scope, just the current one otherwise.
		const customTasksByCol = new Map<string, Task[]>();
		for (const task of activeTasks) {
			if (!task.customColumnId) continue;
			const key = `${task.projectId}|${task.customColumnId}`;
			const existing = customTasksByCol.get(key);
			if (existing) existing.push(task);
			else customTasksByCol.set(key, [task]);
		}
		const orderedCols: { projId: string; col: CustomColumn }[] = [];
		const projectsToScan = scope === "global" ? Array.from(projectById.values()) : [project];
		for (const p of projectsToScan) {
			for (const col of p.customColumns ?? []) orderedCols.push({ projId: p.id, col });
		}
		const customGroups: SidebarGroup[] = [];
		for (const { projId, col } of orderedCols) {
			const colTasks = customTasksByCol.get(`${projId}|${col.id}`);
			if (colTasks && colTasks.length > 0) {
				customGroups.push({ key: `custom:${projId}:${col.id}`, label: col.name, color: col.color, busy: false, tasks: colTasks.sort(byMovedAtOldestFirst) });
			}
		}

		grouped = [...builtinGroups, ...customGroups];
	}

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
					<div role="group" className="inline-flex items-center gap-px" aria-label={t("sidebar.scopeToggleTitle")}>
						{/* Folder \u2014 this project only */}
						<button
							type="button"
							onClick={() => setScope("project")}
							aria-pressed={scope === "project"}
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
						{/* Globe \u2014 all projects */}
						<button
							type="button"
							onClick={() => setScope("global")}
							aria-pressed={scope === "global"}
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
						{/* Bell \u2014 attention mode: cross-project, filtered to tasks needing user input */}
						<button
							type="button"
							onClick={() => setScope("attention")}
							aria-pressed={scope === "attention"}
							title={t("sidebar.scopeAttention")}
							className={`relative inline-flex items-center justify-center h-5 w-5 leading-none transition-colors ${
								scope === "attention"
									? "text-awake"
									: attentionCount > 0
										? "text-awake/70 hover:text-awake"
										: "text-fg-muted hover:text-fg-2"
							}`}
							data-testid="sidebar-scope-attention"
						>
							{/* Nerd Font: nf-fa-bell (U+F0A2) */}
							<span
								className={`text-sm leading-none ${scope !== "attention" && attentionCount > 0 ? "animate-pulse" : ""}`}
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\uF0A2"}
							</span>
							{attentionCount > 0 && scope !== "attention" && (
								<span className="absolute -top-1 -right-1 min-w-[0.875rem] h-3.5 flex items-center justify-center px-0.5 rounded-full bg-awake text-[0.5rem] font-bold text-fg leading-none pointer-events-none">
									{attentionCount > 9 ? "9+" : attentionCount}
								</span>
							)}
						</button>
					</div>
					{activeTaskId && (
						<button
							type="button"
							onClick={() =>
								navigate({ screen: "task", projectId: project.id, taskId: activeTaskId })
							}
							className="inline-flex items-center justify-center h-5 w-5 text-fg-muted hover:text-accent transition-colors rounded hover:bg-fg/5"
							title={t("sidebar.hide")}
							data-testid="sidebar-hide"
						>
							{/* Mirror the fullscreen/"Zoom" toggle in TaskInfoPanel */}
							<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
							</svg>
						</button>
					)}
				</div>
			</div>

			{/* Search input */}
			<div className="px-3 py-1.5 border-b border-edge flex-shrink-0">
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
						data-search-input="true"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
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

			{/* Feature-discovery tip — terminal-context tips lead here (see useTipRotation) */}
			{currentTip && tipState && (
				<div className="px-3 py-2 border-b border-edge flex-shrink-0">
					<TipCard tip={currentTip} tipState={tipState} onChanged={applyTipState} compact />
				</div>
			)}

			{/* Task list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden" data-help-id="sidebar.active-tasks">
				{(scope === "global" || scope === "attention") && globalLoading && grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{t("sidebar.globalLoading")}
					</div>
				) : grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{searchQuery.trim()
							? t("sidebar.noSearchResults")
							: scope === "attention"
								? t("sidebar.noAttentionTasks")
								: t("sidebar.noActiveTasks")}
					</div>
				) : (
					grouped.map(({ key: groupKey, label: groupLabel, color: groupColor, busy: groupBusy, tasks: groupTasks }, groupIdx) => (
						<div key={groupKey}>
							{/* Solid separator between status groups */}
							{groupIdx > 0 && scope !== "attention" && (
								<div className="mx-3 border-t border-edge" />
							)}

							{/* Group header (hidden in attention mode — flat list, no grouping) */}
							{scope !== "attention" && <div className="relative px-3 py-1.5 flex items-center gap-2 sticky top-0 bg-base/95 backdrop-blur-sm z-10">
								{/* Faint status wash + left bar so the group reads as one color zone */}
								<span
									className="absolute inset-0 pointer-events-none"
									style={{ background: statusTint(groupColor, 0.1) }}
								/>
								<span
									className="absolute left-0 top-0 bottom-0 w-[3px]"
									style={{ background: groupColor }}
								/>
								{groupBusy ? (
									<div
										className="w-3 h-3 flex-shrink-0 rounded-full animate-spin"
										style={{
											border: `1.5px solid ${groupColor}33`,
											borderTopColor: groupColor,
										}}
										data-testid={`sidebar-status-spinner-${groupKey}`}
										aria-label={groupLabel}
									/>
								) : (
									<div
										className="w-2 h-2 rounded-full flex-shrink-0 relative"
										style={{ background: groupColor }}
									/>
								)}
								<span className="text-[0.625rem] font-semibold text-fg-3 uppercase tracking-wider">
									{groupLabel}
								</span>
								<span className="text-[0.625rem] text-fg-muted">
									{groupTasks.length}
								</span>
							</div>}

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
								const showProjectBadge = (scope === "global" || scope === "attention") && task.projectId !== project.id;
								const projectBadgeName = taskProject?.name ?? t("sidebar.unknownProject");

								return (
									<div key={task.id}>
										{/* Dashed separator between tasks within the same group */}
										{idx > 0 && (
											<div className="mx-3 border-t border-dashed border-edge" />
										)}
										<button
											data-hint-id={`task:${task.id}`}
											onClick={() => handleTaskClick(task)}
											onMouseEnter={(e) => preview.handlers.onMouseEnter(task.id, e.currentTarget)}
											onMouseLeave={preview.handlers.onMouseLeave}
											className={`w-full text-left px-3 py-2 transition-all relative ${
												isActive
													? "bg-accent/20 ring-1 ring-inset ring-accent/50"
													: "hover:bg-elevated-hover"
											}`}
										>
											{/* Faint status wash so the whole card carries its column color
											    (non-active cards only; active keeps its accent tint). */}
											{!isActive && (
												<span
													className="absolute inset-0 pointer-events-none"
													style={{ background: statusTint(taskColor(task), 0.06) }}
												/>
											)}

											{/* Left rail: status color per card, accent when active. Absolute
											    so it does not shift content; keeps padding symmetric. For
											    busy statuses a bright highlight flows down the rail. */}
											{(() => {
												const isBusy = task.status === "in-progress" || task.status === "review-by-ai";
												const railColor = isActive ? "rgb(var(--accent))" : taskColor(task);
												return (
													<span
														className={`absolute left-0 top-0 bottom-0 overflow-hidden ${isActive ? "w-[4px]" : "w-[3px]"}`}
														style={isActive ? { boxShadow: "0 0 8px rgb(var(--accent) / 0.7)" } : undefined}
														data-testid={`sidebar-status-rail-${task.id}`}
													>
														<span
															className="absolute inset-0"
															style={{ background: railColor, opacity: isBusy ? 0.4 : 1 }}
														/>
														{isBusy && (
															<span
																className="absolute inset-x-0 h-1/2 animate-rail-flow"
																style={{ background: `linear-gradient(180deg, transparent, ${railColor}, transparent)` }}
															/>
														)}
													</span>
												);
											})()}

											{/* Bell badge */}
											{bellCount > 0 && (
												<div
													className="absolute top-1 right-2 min-w-[1rem] h-4 flex items-center justify-center px-1 rounded-full bg-red-500 shadow-sm shadow-red-500/40"
												>
													<span className="text-[0.5625rem] font-bold text-white leading-none">
														{bellCount > 9 ? "9+" : bellCount}
													</span>
												</div>
											)}

												{/* Project badge (global scope only) */}
												{showProjectBadge && (
													<div
														className="mb-1 inline-flex items-center gap-1 max-w-full text-[0.6875rem] font-semibold text-accent bg-accent/10 border border-accent/25 rounded px-1.5 py-[1px]"
														title={projectBadgeName}
														data-testid={`sidebar-project-badge-${task.id}`}
													>
														<span
															aria-hidden
															style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
															className="leading-none text-[0.75rem]"
														>
															{"\uEB01"}
														</span>
														<span className="truncate">{projectBadgeName}</span>
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

												{/* Title */}
												<div className={`text-xs leading-snug break-words ${
													isActive ? "text-fg font-medium" : "text-fg-2"
												}`}>
													{displayTitle}
												</div>

												{/* Overview — shown only for the active task, and only if set.
												    The user's manual edit (`userOverview`) overrides the agent's
												    `overview`, so the user always sees the version they authored. */}
												{(() => {
													if (!isActive) return null;
													const effective = task.userOverview?.trim() || task.overview?.trim() || "";
													if (!effective) return null;
													return (
														<div
															className="mt-1.5 pt-1.5 border-t border-accent/20 text-xs leading-relaxed text-fg-2 whitespace-pre-wrap break-words"
															data-testid={`active-task-overview-${task.id}`}
														>
															{effective}
														</div>
													);
												})()}

												<div className="mt-1 flex items-center gap-1 min-w-0">
													<div className="text-[0.5625rem] text-fg-3 font-mono shrink-0">
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
													{(() => {
														const part = ageParts(task.movedAt, now);
														if (!part) return null;
														const relative =
															part.unit === "s" && part.value < 1
																? t("activity.justNow")
																: t(AGE_UNIT_KEY[part.unit] as Parameters<typeof t>[0], {
																		count: String(part.value),
																	});
														const date = new Date(task.movedAt!).toLocaleString(locale, {
															dateStyle: "medium",
															timeStyle: "short",
														});
														return (
															<span
																className="ml-auto shrink-0 flex items-center gap-0.5 text-[0.5625rem] text-fg-3 font-mono whitespace-nowrap"
																title={t("sidebar.statusChanged", { ago: relative, date })}
																data-testid={`sidebar-status-age-${task.id}`}
															>
																<span
																	aria-hidden
																	className="leading-none"
																	style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
																>
																	{"\uF017"}
																</span>
																{compactAge(task.movedAt, now)}
															</span>
														);
													})()}
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
						userOverview={hoveredTask?.userOverview ?? null}
						description={hoveredTask?.description ?? null}
						attentionReasons={hoveredTask ? bellReasons?.get(hoveredTask.id) : undefined}
					/>
				);
			})()}
		</div>
	);
}

export default ActiveTasksSidebar;
