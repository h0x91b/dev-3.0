import { useState, useEffect, useCallback } from "react";
import type { Dispatch, DragEvent } from "react";
import type { Project, Space, Task, TaskStatus } from "../../shared/types";
import { compareTaskSortRank, getTaskTitle, isBuiltinOpsProject, isTaskDisconnected, orderProjectsForDisplay } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { deleteSpaceWithConfirm, moveSpace, renameSpace, toggleSpaceSensitive } from "../utils/spaceActions";
import { useT } from "../i18n";
import { MASK_CLASS, useProjectPrivacy } from "../sensitive-projects";
import { useSpaces } from "../useSpaces";
import { filterDashboardGroups, groupProjectsForDashboard } from "../utils/spaceGroups";
import ProjectSpaceChips from "./ProjectSpaceChips";
import SpacePicker from "./SpacePicker";
import { useProjectSpaceMembership } from "../useProjectSpaceMembership";
import SpaceGroupedProjects, { type RowReorderCtx } from "./SpaceGroupedProjects";
import { getStatusLabel } from "../utils/statusLabel";
import { statusKey } from "../i18n/status";
import { useStatusColors } from "../hooks/useStatusColors";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import ProjectActionButtons from "./ProjectActionButtons";
import BottomSheet from "./BottomSheet";
import HelpSpot from "./HelpSpot";
import PriorityBadge from "./PriorityBadge";
import Tooltip from "./Tooltip";
import { CompleteCheckIcon } from "./PipelineRing";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

interface ActivityOverviewProps {
	projects: Project[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	onRemoveProject?: (projectId: string) => void | Promise<void>;
	onOpenAddProject?: (spaceIds?: string[]) => void;
	onReorderProjects?: (projectIds: string[]) => void | Promise<void>;
	/** Rail filter: null = all, `HOME_GROUP_ID` = the computed Home group. */
	selectedSpaceId?: string | null;
	onNewSpace?: () => void;
	/** Opens the space's membership editor — the dialog is hosted one level up,
	 *  because the rail's own menu opens the same one. */
	onEditSpaceProjects?: (space: Space) => void;
	/** Present only while the rail is off screen: the filter's stand-in control,
	 *  showing what is currently filtered and opening the picker sheet. */
	spaceFilter?: { label: string; masked?: boolean; onOpen: () => void };
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
				aria-hidden="true"
				className="w-5 flex-shrink-0 text-center text-lg leading-none"
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			>
				{glyph}
			</span>
			<span className="flex-1">{label}</span>
		</button>
	);
}

function ActivityOverview({ projects, dispatch, navigate, bellCounts, onRemoveProject, onOpenAddProject, onReorderProjects, selectedSpaceId = null, onNewSpace, onEditSpaceProjects, spaceFilter }: ActivityOverviewProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [tasksByProject, setTasksByProject] = useState<Map<string, Task[]>>(new Map());
	// Work parked on each board that this screen never lists — the number that
	// makes "Open board" worth clicking instead of a decorative arrow.
	const [todoByProject, setTodoByProject] = useState<Map<string, number>>(new Map());
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
	// Tasks whose row ✓ is in flight — the confirmation dialog it opens runs a git
	// check, so the row has to acknowledge the click before the move lands.
	const [completingTasks, setCompletingTasks] = useState<Set<string>>(new Set());

	const privacy = useProjectPrivacy();
	const { spaces, file: spacesFile } = useSpaces();
	const [projectQuery, setProjectQuery] = useState("");
	// The row whose Spaces… picker is open, with the button it is anchored to.
	const [spacesPicker, setSpacesPicker] = useState<{ projectId: string; anchor: HTMLElement } | null>(null);
	const membership = useProjectSpaceMembership(spacesFile);

	const openSpacesPicker = useCallback((project: Project, anchor: HTMLElement) => {
		setSpacesPicker({ projectId: project.id, anchor });
	}, []);

	function openProject(projectId: string) {
		navigate({ screen: "project", projectId });
	}

	/** One background-work summary segment. A count cannot be glued onto a status
	 * label — that produced "3 agent is working" — so each background status owns a
	 * pluralised sentence. A project that renames the status falls back to
	 * "{count} × {label}", which keeps the custom name verbatim. */
	function summaryLabel(status: TaskStatus, count: number, project: Project): string {
		const label = getStatusLabel(status, t, project);
		const renamed = label !== t(statusKey(status));
		if (renamed) return t("activity.summaryCustom", { count: String(count), label });
		if (status === "in-progress") return t.plural("activity.summaryInProgress", count);
		if (status === "review-by-ai") return t.plural("activity.summaryAiReview", count);
		return t("activity.summaryCustom", { count: String(count), label });
	}

	function toggleProjectExpanded(projectId: string) {
		setExpandedProjects((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	}

	function markCompleting(taskId: string, active: boolean) {
		setCompletingTasks((prev) => {
			const next = new Set(prev);
			if (active) next.add(taskId);
			else next.delete(taskId);
			return next;
		});
	}

	/** Drop / restore a row in this screen's own task list — `dispatch` only
	 *  reverts the shared task state, which the dashboard never reads from. */
	function setRowPresent(task: Task, present: boolean) {
		setTasksByProject((prev) => {
			const next = new Map(prev);
			const tasks = next.get(task.projectId) ?? [];
			if (present) {
				if (!tasks.some((t) => t.id === task.id)) next.set(task.projectId, [...tasks, task]);
			} else {
				next.set(task.projectId, tasks.filter((t) => t.id !== task.id));
			}
			return next;
		});
	}

	/** The row's one object action. Always confirms: this is a one-click ✓ on a
	 *  triage list, so a mis-click must never silently complete a task. */
	async function completeTask(task: Task, project: Project) {
		markCompleting(task.id, true);
		try {
			await moveTaskToStatus({
				task,
				project,
				newStatus: "completed",
				dispatch,
				t,
				afterOptimistic: () => setRowPresent(task, false),
				onFailure: () => setRowPresent(task, true),
				alwaysConfirm: true,
			});
		} finally {
			markCompleting(task.id, false);
		}
	}

	const fetchAllTasks = useCallback(async () => {
		try {
			const results = await api.request.getAllProjectTasks();
			const map = new Map<string, Task[]>();
			const todo = new Map<string, number>();
			for (const { projectId, tasks, todoCount } of results) {
				map.set(projectId, tasks);
				todo.set(projectId, todoCount);
			}
			setTasksByProject(map);
			setTodoByProject(todo);
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
			<div className="h-full overflow-hidden p-3 md:p-7" aria-busy="true">
				<div className="max-w-5xl mx-auto space-y-4 animate-pulse">
					<div className="h-[4.75rem] rounded-2xl border border-edge bg-raised" />
					<div className="flex items-center justify-between gap-4">
						<div className="h-4 w-24 rounded bg-raised" />
						<div className="h-11 md:h-8 w-28 rounded-xl bg-raised" />
					</div>
					{[0, 1, 2].map((i) => (
						<div key={i} className="h-[5.5rem] rounded-2xl border border-edge bg-raised" />
					))}
				</div>
			</div>
		);
	}

	// The built-in Operations board is pinned first; ordinary projects keep order.
	const visibleProjects = orderProjectsForDisplay(projects.filter((p) => !p.deleted));
	// null with zero spaces — the legacy flat render below stays byte-identical.
	const allSpaceGroups = groupProjectsForDashboard(visibleProjects, spacesFile);
	const spaceGroups = filterDashboardGroups(allSpaceGroups, {
		selectedSpaceId,
		query: projectQuery,
		spaces: spacesFile.spaces,
	});
	const sensitiveProjectIds = new Set(projects.filter((p) => p.sensitive).map((p) => p.id));
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

	function renderProjectRow(project: Project, index: number, reorder?: RowReorderCtx, groupSpaceId?: string | null) {
		const tasks = tasksByProject.get(project.id) ?? [];
		const hasActiveTasks = tasks.length > 0;
		const todoCount = todoByProject.get(project.id) ?? 0;
		const isDragged = reorder ? reorder.isDragged : draggedProjectId === project.id;
		// A drag is in flight in this row's reorder scope: every row that can take
		// the drop shrinks to one line for the duration. A row with five tasks is
		// ~300px tall, so a list of them never fits on one screen — the drop target
		// was somewhere the user had to scroll to while holding the pointer down.
		const compact = reorder ? reorder.groupDragActive : draggedProjectId !== null;
		const isBuiltinOps = isBuiltinOpsProject(project);
		const locked = privacy.isLocked(project);
		// Virtual boards (builtin and user-created) cannot be reordered:
		// reorderProjects only persists git project order; dragging a virtual
		// board would silently snap back after the API call. The project right
		// below the pinned builtin also cannot move above the pin.
		const cannotReorder = project.kind === "virtual";
		// Grouped rows reorder within their space (RowReorderCtx); flat rows keep
		// the global projects.json order machinery below.
		const dragEnabled = reorder ? reorder.dragEnabled : !!onReorderProjects && !cannotReorder;
		const cannotMoveUp = reorder
			? !reorder.canMoveUp
			: index === 0 || (hasPinnedBuiltin && index === 1) || cannotReorder;
		const cannotMoveDown = reorder
			? !reorder.canMoveDown
			: !onReorderProjects || index === visibleProjects.length - 1 || cannotReorder;
		const showDropBefore = reorder
			? reorder.showDropBefore
			: dropTarget?.projectId === project.id && dropTarget.side === "before";
		const showDropAfter = reorder
			? reorder.showDropAfter
			: dropTarget?.projectId === project.id && dropTarget.side === "after";

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

		// Order every visible row by priority first (hibernated tasks sink
		// below every live band). On narrow viewports, keep
		// "your turn" ahead of colleague reviews within the same priority band,
		// then cap the list to NARROW_ROW_CAP behind a "show more" fold.
		const rankOf = (task: Task) =>
			columnOf(task) !== null ? 3 : ATTENTION_RANK[task.status] ?? 3;
		const orderedRowTasks = [...rowTasks].sort((a, b) => {
			const byPriority = compareTaskSortRank(a, b);
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
				className={`relative bg-raised border border-edge overflow-hidden transition-opacity ${compact ? "rounded-xl" : "rounded-2xl"} ${isDragged ? "opacity-60" : ""}`}
				data-compact={compact || undefined}
				onDragOver={reorder ? reorder.onDragOver : (event) => handleDragOver(event, project.id)}
				onDragLeave={reorder ? reorder.onDragLeave : () => setDropTarget((current) => current?.projectId === project.id ? null : current)}
				onDrop={reorder ? reorder.onDrop : (event) => handleDrop(event, project.id)}
			>
				{showDropBefore && <div className="absolute top-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />}
				{showDropAfter && <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-accent rounded-full z-10" />}
				{/* Project header */}
				<div className={`group flex items-center gap-2 px-3 md:px-5 ${compact ? "py-1.5" : hasActiveTasks ? "py-3" : "py-2.5"} hover:bg-raised-hover transition-colors`}>
					{/* Reorder cluster — desktop only. On touch, drag and the
					    step buttons are unusable; reorder lives in the action sheet. */}
					{/* A grouped row alone in its space has nothing to reorder. */}
					{(!reorder || reorder.showReorder) && (
					/* A virtual board cannot be reordered at all, so its cluster carried
					   a dead grip and two permanently disabled buttons. Hidden with
					   `invisible`, not removed: the row is pinned above the grouped rows
					   and their names have to start at the same x. `visibility: hidden`
					   also takes the two buttons out of the tab order, which
					   `opacity-0` would not. */
					<div
						aria-hidden={cannotReorder || undefined}
						className={`hidden md:flex -ml-1.5 items-center gap-0.5 ${cannotReorder ? "invisible" : ""}`}
					>
						{/* Pointer-only drag affordance. Deliberately NOT a button: it has
						    no click or key handler, and the step buttons beside it are the
						    keyboard path, so a focusable control here would be a dead tab
						    stop telling keyboard users to perform a gesture. */}
						<span
							role="presentation"
							draggable={dragEnabled}
							onDragStart={(event) => {
								if (!dragEnabled) return;
								if (reorder) {
									reorder.onDragStart(event);
									return;
								}
								setDraggedProjectId(project.id);
								event.dataTransfer.setData("text/plain", `project:${project.id}`);
								event.dataTransfer.effectAllowed = "move";
							}}
							onDragEnd={() => {
								if (reorder) {
									reorder.onDragEnd();
									return;
								}
								setDraggedProjectId(null);
								setDropTarget(null);
							}}
							className={`p-1.5 rounded-lg text-fg-3 transition-colors ${dragEnabled ? "cursor-grab active:cursor-grabbing hover:text-fg hover:bg-elevated" : "cursor-default opacity-60"}`}
							title={dragEnabled ? t("dashboard.reorderProject") : undefined}
						>
							<span
								aria-hidden="true"
								className="text-base leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\u{F01DB}"}
							</span>
						</span>
						<button
							type="button"
							onClick={() => (reorder ? reorder.onMoveUp() : moveProjectByStep(project.id, -1))}
							className="hidden md:flex text-fg-3 hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated disabled:opacity-60 disabled:hover:text-fg-3 disabled:hover:bg-transparent"
							title={t("dashboard.moveProjectUp")}
							aria-label={t("dashboard.moveProjectUp")}
							disabled={reorder ? cannotMoveUp : !onReorderProjects || cannotMoveUp}
						>
							<span
								aria-hidden="true"
								className="text-sm leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\uF062"}
							</span>
						</button>
						<button
							type="button"
							onClick={() => (reorder ? reorder.onMoveDown() : moveProjectByStep(project.id, 1))}
							className="hidden md:flex text-fg-3 hover:text-fg transition-colors p-1.5 rounded-lg hover:bg-elevated disabled:opacity-60 disabled:hover:text-fg-3 disabled:hover:bg-transparent"
							title={t("dashboard.moveProjectDown")}
							aria-label={t("dashboard.moveProjectDown")}
							disabled={cannotMoveDown}
						>
							<span
								aria-hidden="true"
								className="text-sm leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\uF063"}
							</span>
						</button>
					</div>
					)}
					<button
						type="button"
						data-hint-id={`project:${project.id}`}
						onClick={() => openProject(project.id)}
						aria-disabled={locked || undefined}
						title={locked ? t("streamer.projectLocked") : undefined}
						className={`min-w-0 flex-1 flex items-center gap-3 text-left ${locked ? "cursor-not-allowed" : ""}`}
					>
						<div className={`${compact ? "hidden" : hasActiveTasks ? "w-8 h-8" : "w-6 h-6"} rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0`}>
							<svg aria-hidden="true" focusable="false" className={`${hasActiveTasks ? "w-4 h-4" : "w-3 h-3"} text-accent`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
							</svg>
						</div>
						<div className="min-w-0 flex-1">
							<div className={`${hasActiveTasks ? "text-fg font-semibold" : "text-fg-3"} text-sm truncate flex items-center gap-2`}>
								{isBuiltinOps && (
									<span aria-hidden="true" className="text-accent flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
								)}
								{locked && (
							<span
								aria-hidden="true"
								className="text-fg-muted flex-shrink-0"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\u{F033E}"}
							</span>
						)}
						{/* The row's one navigation is into the board, so the name carries
						    link emphasis on row hover. Without it the only cue was the
						    background lifting one step, which reads as "row", not "link". */}
						<span className={`truncate select-text ${locked ? "" : "group-hover:text-accent group-hover:underline decoration-accent/50 underline-offset-2"} ${privacy.maskClass(project)}`} title={locked || isBuiltinOps ? undefined : project.name}>{isBuiltinOps ? t("ops.boardName") : project.name}</span>
									{!isBuiltinOps && !compact && (
										<ProjectSpaceChips
											spaces={spacesFile.spaces}
											projectId={project.id}
											omitSpaceId={groupSpaceId ?? undefined}
											sensitiveProjectIds={sensitiveProjectIds}
										/>
									)}
								{project.kind === "virtual" && (
									<span className="px-1.5 py-0.5 rounded bg-raised text-fg-3 text-dense font-medium uppercase tracking-[0.06em] flex items-center gap-1 flex-shrink-0">
										<span aria-hidden="true" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
										{isBuiltinOps ? t("ops.badgeSystem") : t("ops.badge")}
									</span>
								)}
								{isBuiltinOps && !compact && (
									<span className="hidden md:inline-flex text-fg-3 text-nano font-mono border border-edge rounded px-1 py-0.5 leading-none flex-shrink-0">⌘0</span>
								)}
							</div>
							{/* Subtitle (path / virtual hint) is dead weight on a phone —
							    name + badge already identify the board. Desktop only. */}
							{compact ? null : project.kind === "virtual" ? (
								<div className="hidden md:block text-fg-3 text-xs mt-0.5 truncate">{t("ops.tileSubtitle")}</div>
							) : (
								<div className="hidden md:block text-fg-3 text-xs mt-0.5 truncate font-mono select-text streamer-private" title={project.path}>{project.path}</div>
							)}
						</div>
					</button>
					{/* Desktop: resting-visible inline icon cluster, hover-emphasised. */}
					<div className={compact ? "hidden" : "hidden md:flex"}>
						<ProjectActionButtons
							project={project}
							navigate={navigate}
							onRemove={onRemoveProject}
							onOpenSpaces={allSpaceGroups !== null ? openSpacesPicker : undefined}
						/>
					</div>
					<span className={`items-center gap-3 ${compact ? "hidden" : "flex"}`}>
						{hasActiveTasks ? (
							<span className="text-fg-3 text-xs tabular-nums whitespace-nowrap">{t.plural(narrow ? "activity.taskCountShort" : "activity.taskCount", tasks.length)}</span>
						) : (
							<span className="hidden md:inline text-fg-3 text-xs whitespace-nowrap">{t("activity.noActiveInProject")}</span>
						)}
						{/* Chevron is redundant on narrow — the name + count already
						    navigate, so it only crowds the row end where the kebab sits. */}
						<svg aria-hidden="true" focusable="false" className="hidden md:block w-4 h-4 text-fg-muted group-hover:text-accent group-hover:translate-x-0.5 transition-[color,transform] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
						</svg>
					</span>
					{/* Narrow: a single kebab folds every per-project action + reorder
					    into a bottom sheet. Rendered last so it sits at the true row end. */}
					{narrow && !compact && (
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
							<span aria-hidden="true" className="text-lg leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F01D9}"}</span>
						</button>
					)}
				</div>

				{hasActiveTasks && !compact && (
					<div className="border-t border-edge">
						{/* Attention + custom-column tasks — shown individually. On narrow
						    each row stacks (title on its own line, meta below) so the title
						    is readable instead of squeezed by the status + time cluster. */}
						{visibleRowTasks.map((task) => {
							const col = columnOf(task);
							const rowColor = col ? col.color : statusColors[task.status];
							const rowLabel = col ? col.name : getStatusLabel(task.status, t, project);
							// A user-picked column colour has no per-theme variant, so it is
							// shown as a swatch instead of as text colour (see comment above).
							const labelAsSwatch = col !== null;
							const needsMe = !col && NEEDS_ME_STATUSES.includes(task.status);
							// The row's single object action. A hibernated task refuses column
							// changes in the lifecycle machine, so it gets no ✓ at all.
							// A locked project's rows are blurred, so completing from one would
							// mutate a task the user cannot read.
							const canComplete = !task.hibernated && !locked;
							const completing = completingTasks.has(task.id);
							return (
							<div
								key={task.id}
								className={`group/row relative flex items-stretch hover:bg-raised-hover transition-colors border-b border-edge last:border-b-0 ${task.hibernated || isTaskDisconnected(task) ? "grayscale" : ""}`}
							>
							<button
								data-hint-id={`task:${task.id}`}
								onClick={() => navigate({ screen: "project", projectId: project.id, activeTaskId: task.id })}
								className={`min-w-0 flex-1 flex items-start md:items-center gap-3 pl-3 md:pl-5 py-3 md:py-2.5 min-h-[44px] text-left ${canComplete ? "pr-1" : "pr-3 md:pr-5"}`}
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
										title={getTaskTitle(task)}
										className={`text-fg-2 text-sm min-w-0 md:flex-1 select-text ${narrow ? "line-clamp-2" : "truncate"} ${privacy.maskClass(project)}`}
									>
										{getTaskTitle(task)}
									</span>
									<span className="flex items-center gap-2 md:gap-3 flex-shrink-0">
										{task.hibernated && (
											<span
												data-testid="activity-hibernated-badge"
												className="inline-flex flex-shrink-0 items-center rounded border border-dashed border-edge-active px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] text-fg-3"
											>
												{t("task.hibernatedBadge")}
											</span>
										)}
										{isTaskDisconnected(task) && (
											<span
												data-testid="activity-disconnected-badge"
												title={t("task.disconnectedHint")}
												className="inline-flex flex-shrink-0 items-center rounded border border-dashed border-edge-active px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] text-fg-3"
											>
												{t("task.disconnectedBadge")}
											</span>
										)}
										{bellCounts.has(task.id) && (
											<>
												<span className="sr-only">
													{t.plural("activity.unreadUpdates", bellCounts.get(task.id) ?? 1)}
												</span>
												<span
													aria-hidden="true"
													className="w-2 h-2 rounded-full bg-accent motion-safe:animate-pulse flex-shrink-0"
												/>
											</>
										)}
										{labelAsSwatch ? (
											<span className="flex items-center gap-1.5 min-w-0 flex-shrink">
												<span
													aria-hidden="true"
													className="w-2 h-2 rounded-full flex-shrink-0"
													style={{ backgroundColor: rowColor }}
												/>
												<span className="text-fg-3 text-xs truncate max-w-[8rem]" title={rowLabel}>
													{rowLabel}
												</span>
											</span>
										) : (
											<span className="text-xs flex-shrink-0" style={{ color: rowColor }}>
												{rowLabel}
											</span>
										)}
										{task.movedAt && (
											<span className="text-fg-3 text-xs flex-shrink-0 tabular-nums whitespace-nowrap md:w-16 md:text-right">
												{timeAgo(task.movedAt, t)}
											</span>
										)}
									</span>
								</span>
							</button>
							{canComplete && (
								<Tooltip content={t("pipeline.completeTooltip")} disabled={completing}>
									<button
										type="button"
										data-testid="activity-row-complete"
										onClick={() => void completeTask(task, project)}
										disabled={completing}
										aria-label={`${t("pipeline.completeTooltip")} — ${getTaskTitle(task)}`}
										className={`flex flex-shrink-0 items-center justify-center self-stretch pr-1 md:pr-2 text-success transition-[opacity,background-color,transform] duration-150 ease-out hover:bg-success/10 motion-safe:active:scale-[0.96] ${narrow ? "w-11" : "w-9"} ${
											completing ? "opacity-100" : "md:opacity-0 md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100"
										}`}
									>
										{/* Both glyphs stay mounted and cross-fade — a hard swap on a
										    14px target reads as a flicker. */}
										<span className="relative flex h-4 w-4 items-center justify-center rounded-md">
											<span
												className={`absolute inset-0 h-4 w-4 animate-spin rounded-full border-2 border-success/30 border-t-success transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${completing ? "opacity-100 scale-100 blur-0" : "opacity-0 scale-[0.25] blur-[4px]"}`}
											/>
											<CompleteCheckIcon
												className={`absolute inset-0 h-4 w-4 transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${completing ? "opacity-0 scale-[0.25] blur-[4px]" : "opacity-100 scale-100 blur-0"}`}
											/>
										</span>
									</button>
								</Tooltip>
							)}
							</div>
							);
						})}

						{/* Narrow: fold the long tail behind a touch-sized toggle. */}
						{canCollapse && (
							<button
								type="button"
								onClick={() => toggleProjectExpanded(project.id)}
								aria-expanded={isExpanded}
								className="w-full flex items-center justify-center gap-2 px-3 md:px-5 py-3 min-h-[44px] text-xs text-fg-3 hover:text-fg hover:bg-raised-hover transition-colors border-b border-edge last:border-b-0"
							>
								{isExpanded
									? t("activity.showFewerTasks")
									: t.plural("activity.showMoreTasks", hiddenRowCount)}
							</button>
						)}

					</div>
				)}

				{/* Board footer. Always present, including on a project with nothing
				    active: this is the row's honest statement of what it is NOT
				    showing, and the only place the word "board" appears on desktop.
				    It replaces the old background-summary line, which carried the
				    same counts but led nowhere. */}
				{!compact && (
				<button
					type="button"
					onClick={() => openProject(project.id)}
					aria-disabled={locked || undefined}
					className={`group/board w-full flex items-center gap-3 px-3 md:px-5 py-2.5 min-h-[44px] md:min-h-0 border-t border-edge text-left transition-colors ${locked ? "cursor-not-allowed" : "hover:bg-raised-hover"}`}
					data-testid={`project-open-board-${project.id}`}
				>
					<span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-medium text-fg-3 group-hover/board:text-accent transition-colors">
						<svg aria-hidden="true" focusable="false" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7m0 0H9m8 0v8" />
						</svg>
						{t("activity.openBoard")}
					</span>
					<span className={`flex-1 min-w-0 flex items-center justify-end gap-3 ${privacy.maskClass(project)}`}>
						{summarySegments.map(({ status, count }) => (
							<span key={status} className="flex items-center gap-1.5 text-xs text-fg-3 flex-shrink-0">
								<span
									aria-hidden="true"
									className="w-2 h-2 rounded-full"
									style={{ backgroundColor: statusColors[status] }}
								/>
								<span className="tabular-nums">{summaryLabel(status, count, project)}</span>
							</span>
						))}
						{todoCount > 0 && (
							<span className="text-xs text-fg-3 tabular-nums flex-shrink-0" data-testid={`project-todo-count-${project.id}`}>
								{t.plural("activity.todoOnBoard", todoCount)}
							</span>
						)}
					</span>
				</button>
				)}
			</div>
		);
	}

	// A brand-new install is never at zero projects — the builtin Operations board
	// is created on first boot — so the dashboard's own zero-projects empty state
	// can never render. This is the state that actually happens: an install with
	// no repository in it yet.
	const noRepositoryYet = !projects.some((p) => !p.deleted && !isBuiltinOpsProject(p));

	return (
		<div className="h-full overflow-y-auto p-3 md:p-7">
			<div className="max-w-5xl mx-auto space-y-4">
				{noRepositoryYet ? (
					/* Takes the stats card's slot rather than adding one: a Velocity Cockpit
					   with nothing in it is the wrong first thing to read. Kept to one strip —
					   the centre of the screen belongs to the dashboard, and the `?` earns
					   attention next to itself (bible §5.4a), not in a plate here. */
					<div
						data-help-id="dashboard.first-run"
						data-testid="dashboard-first-run"
						className="rounded-2xl border border-edge bg-raised px-4 md:px-5 py-3.5"
					>
						<h2 className="text-fg text-sm font-semibold text-pretty">{t("dashboard.firstRun.title")}</h2>
						<p className="text-fg-3 text-sm leading-relaxed text-pretty max-w-3xl mt-0.5">{t("dashboard.firstRun.body")}</p>
					</div>
				) : (
				<button
					type="button"
					data-hint-id="dashboard-stats"
					data-help-id="dashboard.stats-entry"
					onClick={() => navigate({ screen: "stats" })}
					className="group w-full flex items-center gap-4 rounded-2xl border border-edge bg-raised hover:bg-raised-hover hover:border-edge-active px-3 md:px-5 py-4 transition-[background-color,border-color] text-left"
				>
					<span aria-hidden="true" className="text-accent text-3xl leading-none shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F04C5}"}</span>
					<div className="flex-1 min-w-0">
						<div className="text-fg font-semibold">{t("stats.cardTitle")}</div>
						<div className="text-fg-3 text-xs mt-0.5 truncate">{t("stats.cardSubtitle")}</div>
					</div>
					<svg aria-hidden="true" focusable="false" className="w-4 h-4 text-fg-muted group-hover:text-accent transition-colors shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
					</svg>
				</button>
				)}
				<div className="flex items-center justify-between gap-4">
					<div>
						<h2 className="flex items-center gap-1.5 text-fg-2 text-sm font-medium">
							{t.plural("dashboard.projectCount", visibleProjects.length)}
							<HelpSpot topicId="dashboard.projects" />
						</h2>
						{totalActive === 0 && (
							<div className="text-fg-3 text-xs mt-1">{t("activity.noActiveTasks")}</div>
						)}
					</div>
					<div className="flex items-center gap-2 flex-shrink-0">
						{/* Fallback only — the rail owns `New space` and passes no handler
						    while it is on screen. When it does render there is no rail at
						    all (commonly a first run with zero spaces), so it stays a full
						    secondary rather than a whisper: it is the only way in. */}
						{onNewSpace && (
							<button
								type="button"
								onClick={onNewSpace}
								/* The rail carries this topic today, and the rail does not exist
								   until a space does — so on a first run Spaces was unexplained
								   exactly when it is hardest to grasp. */
								data-help-id="dashboard.spaces"
								className="flex items-center gap-1.5 flex-shrink-0 px-4 py-1.5 min-h-[44px] md:min-h-0 border border-edge rounded-xl text-fg-2 text-sm hover:text-fg hover:border-edge-active transition-[color,border-color,transform] active:scale-[0.96]"
								data-testid="dashboard-new-space"
							>
								<svg aria-hidden="true" focusable="false" className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
								</svg>
								{t("spaces.newSpace")}
							</button>
						)}
						{onOpenAddProject && (
							<button
								type="button"
								onClick={() => onOpenAddProject()}
								data-help-id="dashboard.add-project"
								className="px-4 py-1.5 min-h-[44px] md:min-h-0 bg-accent-fill text-white text-sm font-semibold rounded-xl hover:bg-accent-fill-hover shadow-lg shadow-accent/20 transition-[background-color,transform] active:scale-[0.96] flex-shrink-0"
							>
								{t("dashboard.addProject")}
							</button>
						)}
					</div>
				</div>
				{/* Search over projects AND their space names — the same rule as the
				    ⌘K palette. Only meaningful once spaces group the list. */}
				{allSpaceGroups !== null && (
					<div className="flex items-center gap-2">
					{/* The filter sits with the search field, not in the header beside
					    `Add project`: both narrow what the list shows, and a filter is
					    not an action (§10). Only rendered while the rail is away. */}
					{spaceFilter && (
						<button
							type="button"
							onClick={spaceFilter.onOpen}
							className="flex items-center gap-1.5 flex-shrink-0 max-w-[45%] px-3 py-2 min-h-[44px] md:min-h-0 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:text-fg hover:border-edge-active transition-colors"
							data-testid="dashboard-space-filter"
						>
							<span aria-hidden="true" className="text-fg-muted text-sm leading-none flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{"\u{F0233}"}
							</span>
							<span className={`truncate ${spaceFilter.masked ? MASK_CLASS : ""}`}>{spaceFilter.label}</span>
						</button>
					)}
					<div className="relative flex-1 min-w-0">
						<input
							type="text"
							value={projectQuery}
							onChange={(e) => setProjectQuery(e.target.value)}
							placeholder={t("spaces.searchPlaceholderDashboard")}
							className="w-full bg-raised border border-edge rounded-xl pl-9 pr-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-edge-active transition-colors"
							data-testid="dashboard-project-search"
							aria-label={t("spaces.searchPlaceholderDashboard")}
						/>
						<span
							aria-hidden="true"
							className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted text-sm leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{""}
						</span>
					</div>
				</div>
				)}
				{spaceGroups === null ? (
					visibleProjects.map((project, index) => renderProjectRow(project, index))
				) : (
					<>
						{visibleProjects.filter(isBuiltinOpsProject).map((p) => renderProjectRow(p, 0))}
						<SpaceGroupedProjects
							groups={spaceGroups}
							sensitiveProjectIds={sensitiveProjectIds}
							needsYouCountOf={(projectId) =>
								(tasksByProject.get(projectId) ?? []).filter((task) => NEEDS_ME_STATUSES.includes(task.status)).length
							}
							workingCountOf={(projectId) =>
								(tasksByProject.get(projectId) ?? []).filter((task) => BACKGROUND_STATUSES.includes(task.status)).length
							}
							onEditProjects={onEditSpaceProjects}
							onRenameSpace={(space, name) => void renameSpace(space, name, t)}
							onDeleteSpace={(space) => void deleteSpaceWithConfirm(space, t)}
							onMoveSpace={(space, delta) => void moveSpace(space, delta, spaces, t)}
							onToggleSensitive={(space, next) => void toggleSpaceSensitive(space, next, t)}
							spaceOrder={spaces.map((s) => s.id)}
							renderProject={(p, ctx, spaceId) => renderProjectRow(p, visibleProjects.findIndex((v) => v.id === p.id), ctx, spaceId)}
							renderBottomBlockProject={(p) => renderProjectRow(p, visibleProjects.findIndex((v) => v.id === p.id))}
						/>
					</>
				)}

				{spacesPicker && (
					<SpacePicker
						spaces={spaces}
						selectedIds={membership.selectedIdsOf(spacesPicker.projectId)}
						onToggle={(spaceId) => void membership.toggle(spacesPicker.projectId, spaceId)}
						onCreateNew={(name) => void membership.createWithProject(name, spacesPicker.projectId)}
						anchorEl={spacesPicker.anchor}
						onClose={() => setSpacesPicker(null)}
					/>
				)}
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
									label={t("activity.openTerminal")}
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
