import { useState, useRef, useEffect, useMemo, useCallback, type Dispatch } from "react";
import { useTaskSortOrder } from "../hooks/useTaskSortOrder";
import type { CodingAgent, PortInfo, Project, Task, TaskPriority, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, ALL_PRIORITIES, DEFAULT_PRIORITY, spacesOfProject } from "../../shared/types";
import { PRIORITY_NAME_KEYS } from "./priorityStyles";
import { groupTasksIntoTiers } from "./sidebarTiers";
import { toast } from "../toast";
import { useStatusColors } from "../hooks/useStatusColors";
import { useTerminalPreview } from "../hooks/useTerminalPreview";
import { api } from "../rpc";
import type { AppAction, Route } from "../state";
import { useT } from "../i18n";
import { getStatusLabel } from "../utils/statusLabel";
import { isFacetTokenActive, matchesTaskQuery, toggleFacetToken } from "../utils/taskSearch";
import { buildFilterGroups, taskQueryContext, isAttentionTask, type FacetResolver, type FilterFunnelOption } from "../utils/taskFacets";
import FilterFunnel from "./FilterFunnel";
import TipCard from "./TipCard";
import { useTipRotation } from "../hooks/useTipRotation";
import TerminalPreviewPopover from "./TerminalPreviewPopover";
import { getTaskAgentMeta } from "../utils/taskAgentMeta";
import Tooltip from "./Tooltip";
import { PanelLeftIcon } from "./TaskIcons";
import ActiveTaskRow from "./ActiveTaskRow";
import { useSpaces } from "../useSpaces";
import { spaceSiblingProjectIds } from "../utils/spaceScope";

type SidebarScope = "project" | "global" | "space";
const LS_SIDEBAR_SCOPE = "dev3-sidebar-scope";

/** Build a translucent fill from a "#rrggbb" status color for subtle tints. */
function statusTint(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function readScope(): SidebarScope {
	try {
		const v = localStorage.getItem(LS_SIDEBAR_SCOPE);
		if (v === "global" || v === "project" || v === "space") return v;
	} catch { /* ignore */ }
	return "project";
}

function writeScope(scope: SidebarScope) {
	try {
		localStorage.setItem(LS_SIDEBAR_SCOPE, scope);
	} catch { /* ignore */ }
}

interface ActiveTasksSidebarProps {
	/** Absent on the dashboard mount: no current project, so the scope locks to
	 *  global ("across all spaces") and the scope switcher is not rendered. */
	project?: Project;
	tasks?: Task[];
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

/**
 * Active statuses offered by the token-DSL filter funnel (the funnel pool only —
 * card grouping is by readiness tier, see {@link groupTasksIntoTiers}). Ordered
 * most-actionable-first for a tidy dropdown.
 */
const STATUS_ORDER: TaskStatus[] = [
	"review-by-user",
	"review-by-colleague",
	"user-questions",
	"in-progress",
	"review-by-ai",
];

/**
 * Nerd Font scope glyph: outline variant by default, filled variant when the
 * scope is active. Both glyphs stay mounted and cross-fade, so the swap
 * animates in both directions without a motion dependency.
 */
function ScopeGlyph({ outline, filled, active }: { outline: string; filled: string; active: boolean }) {
	const motion = "transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
	const shown = "scale-100 opacity-100 blur-0";
	const hidden = "scale-[0.25] opacity-0 blur-[4px]";
	return (
		<span
			aria-hidden
			className="relative inline-flex items-center justify-center text-sm leading-none"
			style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
		>
			<span className={`${motion} ${active ? hidden : shown}`}>{outline}</span>
			<span className={`absolute inset-0 flex items-center justify-center ${motion} ${active ? shown : hidden}`}>
				{filled}
			</span>
		</span>
	);
}

/** Shared chrome for the three scope toggles — press feedback included. */
const SCOPE_BUTTON_CLASS =
	"inline-flex items-center justify-center h-5 w-5 rounded-md leading-none transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]";

/**
 * The glyph swap alone reads as noise at 20px — the selected scope carries an
 * accent-tinted pill, the same "this control is on" language as the rest of the app.
 */
const SCOPE_STATE_CLASS = (active: boolean) =>
	active ? "bg-accent/20 text-accent" : "text-fg-muted hover:text-fg-2 hover:bg-fg/5";

function ActiveTasksSidebar({
	project,
	tasks = [],
	allProjects,
	activeTaskId,
	dispatch,
	navigate,
	agents,
	bellCounts,
	bellReasons,
	taskPorts,
	disableGlobalFindShortcut = false,
}: ActiveTasksSidebarProps) {
	const t = useT();
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
	const { spaces, loading: spacesLoading } = useSpaces();

	// null = the current project is in no space → the button disables and a
	// stored "space" scope falls back to project below.
	const siblingIds = useMemo(
		() => (project ? spaceSiblingProjectIds(spaces, project.id) : null),
		[spaces, project],
	);

	const setScope = useCallback((next: SidebarScope) => {
		setScopeState(next);
		writeScope(next);
	}, []);

	// No current project → the dashboard mount: global is the only meaningful scope.
	const effectiveScope: SidebarScope = !project
		? "global"
		: scope === "space" && siblingIds === null && !spacesLoading
			? "project"
			: scope;

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

	// Always fetch global tasks and re-fetch when switching into global scope.
	// Loading spinner only shows in scoped views so project-scope mounts are silent.
	useEffect(() => {
		let cancelled = false;
		const isScoped = effectiveScope !== "project";
		if (isScoped) setGlobalLoading(true);
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
				if (!cancelled && isScoped) setGlobalLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [effectiveScope]);

	// Keep global tasks live across all projects.
	useEffect(() => {
		if (effectiveScope === "project") return;
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
	}, [effectiveScope]);

	const sourceTasks = effectiveScope === "project" ? tasks : globalTasks;

	let activeTasks = sourceTasks.filter((task) => ACTIVE_STATUSES.includes(task.status));
	if (effectiveScope === "space" && siblingIds) {
		activeTasks = activeTasks.filter((task) => siblingIds.has(task.projectId));
	}

	const projectById = useMemo(() => {
		const map = new Map<string, Project>();
		if (allProjects) {
			for (const p of allProjects) map.set(p.id, p);
		}
		if (project) map.set(project.id, project);
		return map;
	}, [allProjects, project]);

	// Facet resolver + funnel pool for the token-DSL filter. Labels/statuses are
	// resolved per the task's OWN project (the pool may be cross-project in
	// global scope). The sidebar has no per-task PR number.
	const resolver: FacetResolver = useMemo(() => ({
		agents,
		labelsFor: (task) => {
			const pool = projectById.get(task.projectId)?.labels ?? [];
			return pool.filter((l) => task.labelIds?.includes(l.id));
		},
		statusValuesFor: (task) => {
			const proj = projectById.get(task.projectId);
			const col = task.customColumnId ? proj?.customColumns?.find((c) => c.id === task.customColumnId) : undefined;
			const label = getStatusLabel(task.status, t, proj);
			return col ? [col.name, task.status, label] : [task.status, label];
		},
		priorityFor: (task) => task.priority ?? DEFAULT_PRIORITY,
		hasPortFor: (task) => (taskPorts.get(task.id)?.length ?? 0) > 0,
		isAttentionFor: (task) => isAttentionTask(task),
		// Space names come from the task's OWN project, so a cross-project pool
		// can be filtered by space; a single-project pool yields one value.
		spaceNamesFor: (task) => spacesOfProject(spaces, task.projectId).map((s) => s.name),
	}), [agents, projectById, taskPorts, spaces, t]);

	const priorityCandidates = useMemo<FilterFunnelOption[]>(
		() => ALL_PRIORITIES.map((p) => ({ facet: "priority" as const, value: p, label: `${p} — ${t(PRIORITY_NAME_KEYS[p])}` })),
		[t],
	);
	// The sidebar offers only the active statuses it displays (STATUS_ORDER),
	// plus any custom columns present across the projects in scope.
	const statusCandidates = useMemo<FilterFunnelOption[]>(() => {
		const byValue = new Map<string, FilterFunnelOption>();
		for (const status of STATUS_ORDER) {
			byValue.set(status.toLowerCase(), { facet: "status", value: status, label: getStatusLabel(status, t, project) });
		}
		for (const proj of projectById.values()) {
			for (const col of proj.customColumns ?? []) {
				const key = col.name.toLowerCase();
				if (!byValue.has(key)) byValue.set(key, { facet: "status", value: col.name, label: col.name, color: col.color });
			}
		}
		return [...byValue.values()];
	}, [projectById, project, t]);

	const filterGroups = useMemo(
		() => buildFilterGroups(activeTasks, resolver, {
			priorityCandidates,
			statusCandidates,
			flagLabels: { attention: t("filter.flag.attention"), port: t("filter.flag.port"), home: t("spaces.homeGroup") },
		}),
		[activeTasks, resolver, priorityCandidates, statusCandidates, t],
	);

	if (searchQuery.trim()) {
		activeTasks = activeTasks.filter((task) => matchesTaskQuery(task, searchQuery, taskQueryContext(task, resolver)));
	}

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

	// A rendered readiness-tier block.
	interface SidebarGroup {
		key: string;
		label: string;
		color: string;
		tasks: Task[];
	}

	const sortOrder = useTaskSortOrder();

	// Custom columns in render order (project order). Scan all projects in global
	// scope, just the current one otherwise — mirrors the kanban's column order.
	const orderedCustomColumns = useMemo(() => {
		const cols: { projectId: string; columnId: string }[] = [];
		const projectsToScan =
			effectiveScope === "global"
				? Array.from(projectById.values())
				: effectiveScope === "space" && siblingIds
					? Array.from(projectById.values()).filter((p) => siblingIds.has(p.id))
					: project ? [project] : [];
		for (const p of projectsToScan) {
			for (const col of p.customColumns ?? []) cols.push({ projectId: p.id, columnId: col.id });
		}
		return cols;
	}, [scope, projectById, project]);

	// Readiness tiers: NEEDS YOU → custom columns → WAITING. Grouping +
	// within-tier ordering is a pure function so it is unit-tested without
	// rendering; here we only map it to header chrome.
	const tiers = groupTasksIntoTiers(activeTasks, { scope: effectiveScope, orderedCustomColumns, sortOrder });
	const grouped: SidebarGroup[] = tiers.map((tier) => {
		if (tier.kind === "needs-you") {
			return {
				key: tier.key,
				label: t("sidebar.tier.needsYou"),
				// Warm attention hue (the "act now" zone), matching the bell.
				color: statusColors["user-questions"],
				tasks: tier.tasks,
			};
		}
		if (tier.kind === "waiting") {
			return {
				key: tier.key,
				label: t("sidebar.tier.waiting"),
				// Neutral grey — nothing needs the user in this zone.
				color: statusColors["review-by-ai"],
				tasks: tier.tasks,
			};
		}
		// Custom column — resolve its own name + color from the owning project.
		const col = projectById.get(tier.projectId!)?.customColumns?.find((c) => c.id === tier.customColumnId);
		return {
			key: tier.key,
			label: col?.name ?? "",
			color: col?.color ?? statusColors["in-progress"],
			tasks: tier.tasks,
		};
	});

	const handleSetPriority = useCallback(
		async (task: Task, priority: TaskPriority) => {
			try {
				// Group-wide: the RPC returns every changed task in the variant group.
				// Use the task's OWN project so it works in cross-project scopes too.
				const changed = await api.request.setTaskPriority({ taskId: task.id, projectId: task.projectId, priority });
				for (const changedTask of changed) dispatch({ type: "updateTask", task: changedTask });
			} catch (err) {
				toast.error(t("priority.failedSet", { error: String(err) }), { taskId: task.id });
			}
		},
		[dispatch, t],
	);

	function handleTaskClick(task: Task) {
		if (task.shuttingDown) return;
		preview.close();
		const targetProjectId = task.projectId || project?.id;
		if (!targetProjectId) return;
		if (task.id === activeTaskId && project && targetProjectId === project.id) {
			navigate({ screen: "project", projectId: project.id });
			return;
		}
		navigate({
			screen: "project",
			projectId: targetProjectId,
			activeTaskId: task.id,
		});
	}

	const projectLabels = project?.labels ?? [];

	return (
		<nav className="h-full flex flex-col bg-base" aria-label={t("nav.activeTasks")}>
			{/* Header */}
			<div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-edge flex-shrink-0">
				<span className="min-w-0 flex flex-col">
					<span className="text-xs font-semibold text-fg-2 uppercase tracking-wider truncate">
						{t("sidebar.activeTasks")}
					</span>
					{!project && (
						<span className="text-fg-muted text-nano truncate">{t("spaces.acrossAllSpaces")}</span>
					)}
				</span>
				<div className="flex items-center gap-2 flex-shrink-0 h-5">
					{/* Dashboard mount: no scope switcher (global is the only scope),
					    but the mock's All / Needs-you preset over `is:attention`. */}
					{!project && (
						<div role="group" className="inline-flex items-center rounded-lg bg-raised p-0.5" aria-label={t("sidebar.scopeToggleTitle")}>
							{/* Presets toggle ONLY the `is:attention` token, so any other
							    filter the user set (space:, label:, free text) survives. */}
							{([
								{ key: "all", label: t("spaces.filterAll"), wantsAttention: false },
								{ key: "attention", label: t("spaces.filterNeedsYou"), wantsAttention: true },
							] as const).map(({ key, label, wantsAttention }) => {
								const attentionOn = isFacetTokenActive(searchQuery, "is", "attention");
								return (
									<button
										key={key}
										type="button"
										onClick={() => {
											if (attentionOn !== wantsAttention) {
												setSearchQuery(toggleFacetToken(searchQuery, "is", "attention"));
											}
										}}
										aria-pressed={attentionOn === wantsAttention}
										className={`px-2 py-0.5 rounded-md text-nano font-medium transition-colors ${
											attentionOn === wantsAttention ? "bg-accent/20 text-accent" : "text-fg-3 hover:text-fg-2"
										}`}
										data-testid={`sidebar-preset-${key}`}
									>
										{label}
									</button>
								);
							})}
						</div>
					)}
					{project && (
					<div
							role="group"
							className="inline-flex items-center gap-px rounded-lg bg-raised p-0.5"
							aria-label={t("sidebar.scopeToggleTitle")}
						>
						{/* Folder \u2014 this project only */}
						<Tooltip content={t("sidebar.scopeProject")} detail={t("ttip.sidebar.scopeProject")} placement="bottom">
							<button
								type="button"
								onClick={() => setScope("project")}
								aria-pressed={scope === "project"}
								aria-label={t("sidebar.scopeProject")}
								className={`${SCOPE_BUTTON_CLASS} ${SCOPE_STATE_CLASS(scope === "project")}`}
								data-testid="sidebar-scope-project"
							>
								{/* Nerd Font: nf-fa-folder_open_o (U+F115) \u2192 nf-fa-folder_open (U+F07C) */}
								<ScopeGlyph outline={"\uF115"} filled={"\uF07C"} active={scope === "project"} />
							</button>
						</Tooltip>
						{/* Ring \u2014 the current project's spaces (union of sibling projects).
						    Absent until a space exists at all: someone who never opted in
						    must see yesterday's switcher. Disabled (not hidden) when spaces
						    exist but this project is in none \u2014 there the tooltip teaches. */}
						{spaces.length > 0 && (
						<Tooltip
							content={t("sidebar.scopeSpace")}
							detail={siblingIds === null ? t("ttip.sidebar.scopeSpaceDisabled") : t("ttip.sidebar.scopeSpace")}
							placement="bottom"
						>
							<button
								type="button"
								onClick={() => siblingIds !== null && setScope("space")}
								aria-pressed={scope === "space"}
								aria-disabled={siblingIds === null || undefined}
								aria-label={t("sidebar.scopeSpace")}
								className={`${SCOPE_BUTTON_CLASS} ${
									siblingIds === null
										? "text-fg-muted/40 cursor-not-allowed"
										: SCOPE_STATE_CLASS(scope === "space")
								}`}
								data-testid="sidebar-scope-space"
							>
								{/* Nerd Font: nf-cod-circle_large_outline (U+EABC) \u2192 nf-cod-circle_large_filled (U+EBB5) */}
								<ScopeGlyph outline={"\uEABC"} filled={"\uEBB5"} active={scope === "space"} />
							</button>
						</Tooltip>
						)}
						{/* Globe \u2014 all projects */}
						<Tooltip content={t("sidebar.scopeGlobal")} detail={t("ttip.sidebar.scopeGlobal")} placement="bottom">
							<button
								type="button"
								onClick={() => setScope("global")}
								aria-pressed={scope === "global"}
								aria-label={t("sidebar.scopeGlobal")}
								className={`${SCOPE_BUTTON_CLASS} ${SCOPE_STATE_CLASS(scope === "global")}`}
								data-testid="sidebar-scope-global"
							>
								{/* Nerd Font: nf-cod-globe (U+EB01) \u2014 no filled counterpart, so the
								    active state rests on color alone. */}
								<ScopeGlyph outline={"\uEB01"} filled={"\uEB01"} active={scope === "global"} />
							</button>
						</Tooltip>
					</div>
					)}
					{activeTaskId && (
						<Tooltip content={t("sidebar.hide")} detail={t("ttip.sidebar.hide")} placement="bottom">
							<button
								type="button"
								onClick={() => {
									if (project) navigate({ screen: "task", projectId: project.id, taskId: activeTaskId });
								}}
								className="task-anim inline-flex items-center justify-center h-5 w-5 rounded text-fg-muted hover:text-accent hover:bg-fg/5 transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]"
								aria-label={t("sidebar.hide")}
								data-testid="sidebar-hide"
							>
								{/* VS Code-style panel toggle; the counterpart lives in TaskInfoPanel (isFullPage) */}
								<PanelLeftIcon open className="w-3.5 h-3.5" />
							</button>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Search input + token-DSL filter funnel */}
			<div className="px-3 py-1.5 border-b border-edge flex-shrink-0 flex items-center gap-1.5">
				<div className="relative flex-1 min-w-0">
					<svg
						className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-3 pointer-events-none"
						fill="none"
						viewBox="0 0 24 24"
						strokeWidth={1.5}
						stroke="currentColor"
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
					</svg>
					<input
						ref={searchRef}
						type="text"
						data-search-input="true"
						aria-label={t("sidebar.searchAriaLabel")}
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
						className="w-full pl-6 pr-5 py-1 text-xs bg-base border border-edge rounded-md text-fg placeholder:text-fg-muted focus:border-edge-active transition-colors"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg text-xs leading-none transition-[color,scale] duration-150 ease-out active:scale-[0.96]"
						>
							×
						</button>
					)}
				</div>
				<FilterFunnel query={searchQuery} onChange={setSearchQuery} groups={filterGroups} size="xs" helpTopicId="filters.dsl" />
			</div>

			{/* Feature-discovery tip — terminal-context tips lead here (see useTipRotation) */}
			{currentTip && tipState && (
				<div className="px-3 py-2 border-b border-edge flex-shrink-0">
					<TipCard tip={currentTip} tipState={tipState} onChanged={applyTipState} compact />
				</div>
			)}

			{/* Task list */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden" data-help-id="sidebar.active-tasks">
				{effectiveScope !== "project" && globalLoading && grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{t("sidebar.globalLoading")}
					</div>
				) : grouped.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-fg-muted">
						{searchQuery.trim() ? (
							t("sidebar.noSearchResults")
						) : (
							<>
								<p>{t("sidebar.noActiveTasks")}</p>
								<p className="mt-1">{t("sidebar.noActiveTasksHint")}</p>
							</>
						)}
					</div>
				) : (
					grouped.map(({ key: groupKey, label: groupLabel, color: groupColor, tasks: groupTasks }, groupIdx) => (
						<div key={groupKey}>
							{/* Solid separator between readiness-tier blocks */}
							{groupIdx > 0 && (
								<div className="mx-3 border-t border-edge" />
							)}

							{/* Tier header with count. No spinner: the WAITING tier merges
							    working + AI-review + PRs, so a tier-wide spinner would mislead;
							    the per-card rail busy-flow animation remains the cue. */}
							<div className="relative px-3 py-1.5 flex items-center gap-2 sticky top-0 bg-base/95 backdrop-blur-sm z-10">
								{/* Faint zone wash + left bar so the tier reads as one color zone */}
								<span
									className="absolute inset-0 pointer-events-none"
									style={{ background: statusTint(groupColor, 0.1) }}
								/>
								<span
									className="absolute left-0 top-0 bottom-0 w-[3px]"
									style={{ background: groupColor }}
								/>
								<div
									className="w-2 h-2 rounded-full flex-shrink-0 relative"
									style={{ background: groupColor }}
								/>
								<span className="text-dense font-semibold text-fg-3 uppercase tracking-wider">
									{groupLabel}
								</span>
								<span className="text-dense text-fg-muted" data-testid={`sidebar-tier-count-${groupKey}`}>
									{groupTasks.length}
								</span>
							</div>

							{/* Tasks in this status */}
							{groupTasks.map((task, idx) => {
								const isActive = task.id === activeTaskId && task.projectId === project?.id;
								const bellCount = bellCounts.get(task.id) ?? 0;
								const { agent, configLabel } = getTaskAgentMeta(task, agents);
								const taskLabelIds = task.labelIds ?? [];
								const taskProject = projectById.get(task.projectId) ?? project;
								// Dashboard mount: a task whose project is not in `allProjects`
								// cannot be rendered (the row needs its project for labels).
								if (!taskProject) return null;
								const labelsPool = (taskProject?.labels ?? projectLabels) as typeof projectLabels;
								const assignedLabels = taskLabelIds
									.map((id) => labelsPool.find((l) => l.id === id))
									.filter(Boolean) as typeof projectLabels;
								const groupMembers = task.groupId ? siblingMap.get(task.groupId) ?? [task] : [task];
								const showProjectBadge = effectiveScope !== "project" && task.projectId !== project?.id;

								return (
									<div key={task.id}>
										{/* Dashed separator between tasks within the same group */}
										{idx > 0 && (
											<div className="mx-3 border-t border-dashed border-edge" />
										)}
										<ActiveTaskRow
											task={task}
											taskProject={taskProject}
											isActive={isActive}
											bellCount={bellCount}
											agent={agent}
											agents={agents}
											configLabel={configLabel}
											assignedLabels={assignedLabels}
											groupMembers={groupMembers}
											projectBadgeName={showProjectBadge ? taskProject?.name ?? t("sidebar.unknownProject") : undefined}
											ports={taskPorts.get(task.id)}
											statusColors={statusColors}
											color={taskColor(task)}
											now={now}
											dispatch={dispatch}
											navigate={navigate}
											onOpen={() => handleTaskClick(task)}
											onSetPriority={(p) => handleSetPriority(task, p)}
											onMouseEnter={(e) => preview.handlers.onMouseEnter(task.id, e.currentTarget)}
											onMouseLeave={preview.handlers.onMouseLeave}
											closePreview={preview.close}
										/>
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
						projectId={project?.id ?? hoveredTask?.projectId ?? ""}
						overview={hoveredTask?.overview ?? null}
						userOverview={hoveredTask?.userOverview ?? null}
						description={hoveredTask?.description ?? null}
						attentionReasons={hoveredTask ? bellReasons?.get(hoveredTask.id) : undefined}
					/>
				);
			})()}
		</nav>
	);
}

export default ActiveTasksSidebar;
