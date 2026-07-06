import { useState, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import type { CodingAgent, Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle, hexToRgb, isBuiltinOpsProject, orderProjectsForDisplay } from "../../shared/types";
import { api } from "../rpc";
import type { Route } from "../state";
import { useT, useLocale, statusKey } from "../i18n";
import { useStatusColors } from "../hooks/useStatusColors";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { matchesSearchQuery } from "../utils/taskSearch";
import { ageParts, compactAge, type AgeUnit } from "../utils/statusAge";
import { getTaskAgentMeta } from "../utils/taskAgentMeta";
import LabelChip from "./LabelChip";
import AgentLauncherBadge from "./AgentLauncherBadge";
import VariantDots from "./VariantDots";
import MobileBoardCarousel, { CAROUSEL_MAX_WIDTH, type CarouselColumn } from "./MobileBoardCarousel";
import { PaletteShell } from "./PaletteShell";

/** Open the shared CreateTaskModal (mounted in App) bound to a chosen project. */
function openCreateTaskFor(projectId: string) {
	window.dispatchEvent(new CustomEvent("rpc:openCreateTaskModal", { detail: { projectId } }));
}

/**
 * Columns of the unified cross-project board — `todo` plus every active status,
 * in lifecycle order (left = earliest). This is the "everything I'm working on"
 * set the board exists to surface (see UX_DECISIONS 2026-07-06). Custom columns
 * are per-project and cannot be aggregated, so a task parked in one shows under
 * its underlying built-in `status` column.
 */
const BOARD_STATUSES: TaskStatus[] = [
	"todo",
	"in-progress",
	"user-questions",
	"review-by-ai",
	"review-by-user",
	"review-by-colleague",
];

const BOARD_STATUS_SET = new Set<TaskStatus>(BOARD_STATUSES);

/** Maps the single most-significant age unit to its verbose i18n key. */
const AGE_UNIT_KEY: Record<AgeUnit, string> = {
	s: "activity.secondsAgo",
	m: "activity.minutesAgo",
	h: "activity.hoursAgo",
	d: "activity.daysAgo",
	M: "activity.monthsAgo",
	y: "activity.yearsAgo",
};

/** Oldest-waiting-first within a column: the task most at risk of being forgotten
 * sits on top, mirroring the sidebar work-queue ordering. `seq` breaks ties. */
function byMovedAtOldestFirst(a: Task, b: Task): number {
	const aTime = a.movedAt ? new Date(a.movedAt).getTime() : Infinity;
	const bTime = b.movedAt ? new Date(b.movedAt).getTime() : Infinity;
	if (aTime !== bTime) return aTime - bTime;
	return a.seq - b.seq;
}

interface CardContext {
	projectById: Map<string, Project>;
	agents: CodingAgent[];
	statusColors: Record<TaskStatus, string>;
	bellCounts: Map<string, number>;
	siblingMap: Map<string, Task[]>;
	now: number;
	locale: string;
	onOpen: (task: Task) => void;
}

function BoardCard({ task, ctx }: { task: Task; ctx: CardContext }) {
	const t = useT();
	const project = ctx.projectById.get(task.projectId);
	const { agent, configLabel } = getTaskAgentMeta(task, ctx.agents);
	const agentSummary = [agent?.name, configLabel].filter(Boolean).join(" · ");
	const labelsPool = project?.labels ?? [];
	const assignedLabels = (task.labelIds ?? [])
		.map((id) => labelsPool.find((l) => l.id === id))
		.filter(Boolean) as typeof labelsPool;
	const groupMembers = task.groupId ? ctx.siblingMap.get(task.groupId) ?? [task] : [task];
	const bellCount = ctx.bellCounts.get(task.id) ?? 0;
	const railColor = ctx.statusColors[task.status];
	const projectName = project?.name ?? t("board.unknownProject");
	const part = ageParts(task.movedAt, ctx.now);
	const ageTitle = part
		? t("sidebar.statusChanged", {
				ago:
					part.unit === "s" && part.value < 1
						? t("activity.justNow")
						: t(AGE_UNIT_KEY[part.unit] as Parameters<typeof t>[0], { count: String(part.value) }),
				date: new Date(task.movedAt!).toLocaleString(ctx.locale, { dateStyle: "medium", timeStyle: "short" }),
			})
		: undefined;

	return (
		<button
			data-hint-id={`task:${task.id}`}
			data-testid={`board-card-${task.id}`}
			onClick={() => ctx.onOpen(task)}
			className="relative w-full text-left rounded-lg border border-edge bg-base hover:bg-elevated-hover hover:border-edge-active transition-colors px-3 py-2.5 overflow-hidden"
		>
			{/* Left status rail */}
			<span
				className="absolute left-0 top-0 bottom-0 w-[3px]"
				style={{ background: railColor }}
				data-testid={`board-card-rail-${task.id}`}
			/>

			{/* Bell badge */}
			{bellCount > 0 && (
				<span className="absolute top-1.5 right-2 min-w-[1rem] h-4 flex items-center justify-center px-1 rounded-full bg-red-500 shadow-sm shadow-red-500/40">
					<span className="text-[0.5625rem] font-bold text-white leading-none">
						{bellCount > 9 ? "9+" : bellCount}
					</span>
				</span>
			)}

			{/* Project badge — this board is cross-project, so every card names its project */}
			<div
				className="mb-1 inline-flex items-center gap-1 max-w-full text-[0.6875rem] font-semibold text-accent bg-accent/10 border border-accent/25 rounded px-1.5 py-[1px]"
				title={projectName}
				data-testid={`board-project-badge-${task.id}`}
			>
				{/* Nerd Font: nf-cod-globe (U+EB01) */}
				<span aria-hidden style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }} className="leading-none text-[0.75rem]">
					{""}
				</span>
				<span className="truncate">{projectName}</span>
			</div>

			{/* Agent + variant row */}
			<div className="mb-1 flex items-center gap-1.5 min-w-0">
				{agent && <AgentLauncherBadge agent={agent} size={14} />}
				<div className="min-w-0 flex-1 truncate text-[0.625rem] font-medium text-fg-2" title={agentSummary || undefined}>
					{agentSummary || `#${task.seq}`}
				</div>
				{task.variantIndex !== null && (
					<VariantDots
						groupMembers={groupMembers}
						currentTaskId={task.id}
						statusColors={ctx.statusColors}
						testId={`board-variant-${task.id}`}
					/>
				)}
			</div>

			{/* Title */}
			<div className="text-xs leading-snug break-words text-fg-2">{getTaskTitle(task)}</div>

			{/* Footer: seq · labels · age */}
			<div className="mt-1 flex items-center gap-1 min-w-0">
				<span className="text-[0.5625rem] text-fg-3 font-mono shrink-0">#{task.seq}</span>
				{assignedLabels.length > 0 && (
					<div className="flex flex-wrap gap-0.5 min-w-0">
						{assignedLabels.map((label) => (
							<LabelChip key={label.id} label={label} size="xs" />
						))}
					</div>
				)}
				{compactAge(task.movedAt, ctx.now) && (
					<span
						className="ml-auto shrink-0 flex items-center gap-0.5 text-[0.5625rem] text-fg-3 font-mono whitespace-nowrap"
						title={ageTitle}
						data-testid={`board-card-age-${task.id}`}
					>
						<span aria-hidden className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{""}
						</span>
						{compactAge(task.movedAt, ctx.now)}
					</span>
				)}
			</div>
		</button>
	);
}

function BoardColumn({
	label,
	color,
	tasks,
	ctx,
	fullWidth,
}: {
	label: string;
	color: string;
	tasks: Task[];
	ctx: CardContext;
	fullWidth?: boolean;
}) {
	const t = useT();
	return (
		<div
			className={`group/col relative flex flex-col flex-shrink-0 glass-column column-glow rounded-2xl border border-edge ${
				fullWidth ? "w-full" : "w-[17.5rem]"
			}`}
			style={{ "--col-rgb": hexToRgb(color) } as CSSProperties}
			data-testid={`board-column-${label}`}
		>
			{/* Column header */}
			<div className="px-3 py-2.5 flex-shrink-0 flex items-center gap-2">
				<span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
				<span className="text-fg text-sm font-semibold truncate">{label}</span>
				<span className="text-[0.625rem] font-bold text-fg-muted bg-fg/10 px-1.5 py-px rounded-full flex-shrink-0">
					{tasks.length}
				</span>
			</div>

			{/* Cards */}
			<div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2 kanban-scroll">
				{tasks.length === 0 ? (
					<div className="px-2 py-6 text-center text-[0.6875rem] text-fg-muted">{t("board.columnEmpty")}</div>
				) : (
					tasks.map((task) => <BoardCard key={task.id} task={task} ctx={ctx} />)
				)}
			</div>
		</div>
	);
}

interface AllTasksBoardProps {
	projects: Project[];
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	/** The Dashboard view-mode toggle, rendered in this board's header. */
	viewToggle?: ReactNode;
}

/**
 * Unified cross-project Kanban: one board aggregating every project's active
 * work (todo + all active statuses) so the user sees everything at a glance.
 * A read-only "glance" surface — clicking a card opens the task in its own
 * project board; status changes stay on the per-project board (drag is
 * intentionally omitted; see UX_DECISIONS 2026-07-06).
 */
function AllTasksBoard({ projects, navigate, bellCounts, viewToggle }: AllTasksBoardProps) {
	const t = useT();
	const [locale] = useLocale();
	const statusColors = useStatusColors();
	const isCarousel = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [loading, setLoading] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	// When true, the project typeahead is open (step 1 of creating a task from the
	// cross-project board — the user must pick which project it belongs to).
	const [pickingProject, setPickingProject] = useState(false);
	// Re-render once per second so the status-age badges stay live.
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const results = await api.request.getAllProjectTasks({ includeTodo: true });
				if (cancelled) return;
				const flat: Task[] = [];
				for (const { tasks: projectTasks } of results) {
					for (const task of projectTasks) flat.push(task);
				}
				setTasks(flat);
			} catch (err) {
				if (!cancelled) console.error("Failed to load all tasks for board:", err);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Stay live across every project: apply task updates, dropping tasks that
	// leave the board's status set and adding ones that enter it.
	useEffect(() => {
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent).detail as { task: Task };
			setTasks((prev) => {
				const idx = prev.findIndex((tk) => tk.id === task.id);
				if (BOARD_STATUS_SET.has(task.status)) {
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
	}, []);

	const projectById = useMemo(() => {
		const map = new Map<string, Project>();
		for (const p of projects) map.set(p.id, p);
		return map;
	}, [projects]);

	const siblingMap = useMemo(() => {
		const map = new Map<string, Task[]>();
		for (const task of tasks) {
			if (!task.groupId) continue;
			const existing = map.get(task.groupId);
			if (existing) existing.push(task);
			else map.set(task.groupId, [task]);
		}
		return map;
	}, [tasks]);

	const visibleTasks = useMemo(() => {
		if (!searchQuery.trim()) return tasks;
		return tasks.filter((task) => matchesSearchQuery(task, searchQuery));
	}, [tasks, searchQuery]);

	const tasksByStatus = useMemo(() => {
		const map = new Map<TaskStatus, Task[]>();
		for (const status of BOARD_STATUSES) map.set(status, []);
		for (const task of visibleTasks) {
			map.get(task.status)?.push(task);
		}
		for (const status of BOARD_STATUSES) {
			map.get(status)!.sort(byMovedAtOldestFirst);
		}
		return map;
	}, [visibleTasks]);

	const ctx: CardContext = {
		projectById,
		agents,
		statusColors,
		bellCounts,
		siblingMap,
		now,
		locale,
		onOpen: (task) => navigate({ screen: "project", projectId: task.projectId, activeTaskId: task.id }),
	};

	const total = tasks.length;

	// Projects the user can create a task in — non-deleted, in display order.
	const selectableProjects = useMemo(
		() => orderProjectsForDisplay(projects.filter((p) => !p.deleted)),
		[projects],
	);

	// "New task" on the cross-project board: pick a project first (skip the picker
	// when there is only one), then the shared CreateTaskModal opens for it.
	function startCreate() {
		if (selectableProjects.length === 1) {
			openCreateTaskFor(selectableProjects[0].id);
			return;
		}
		if (selectableProjects.length > 0) setPickingProject(true);
	}

	const carouselColumns: CarouselColumn[] = isCarousel
		? BOARD_STATUSES.map((status) => ({
				id: status,
				label: t(statusKey(status)),
				color: statusColors[status],
				count: tasksByStatus.get(status)?.length ?? 0,
				element: (
					<BoardColumn
						label={t(statusKey(status))}
						color={statusColors[status]}
						tasks={tasksByStatus.get(status) ?? []}
						ctx={ctx}
						fullWidth
					/>
				),
			}))
		: [];

	return (
		<div className="h-full flex flex-col bg-base">
			{/* Header */}
			<div className="flex items-center gap-3 px-3 md:px-6 py-3 border-b border-edge flex-shrink-0 flex-wrap">
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-fg font-semibold text-sm">{t("board.title")}</span>
					<span className="text-fg-3 text-xs">{t.plural("board.taskCount", total)}</span>
				</div>
				<div className="flex-1" />
				{/* Search */}
				<div className="relative w-40 sm:w-56 order-last sm:order-none flex-shrink-0">
					<svg
						className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-3 pointer-events-none"
						fill="none"
						viewBox="0 0 24 24"
						strokeWidth={2}
						stroke="currentColor"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
						/>
					</svg>
					<input
						type="text"
						data-search-input="true"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								e.stopPropagation();
								setSearchQuery("");
								(e.target as HTMLInputElement).blur();
							}
						}}
						placeholder={t("board.searchPlaceholder")}
						className="w-full pl-6 pr-5 py-1.5 text-xs bg-base border border-edge rounded-md text-fg placeholder:text-fg-muted focus:outline-none focus:border-edge-active transition-colors"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg text-xs leading-none"
							aria-label={t("board.clearSearch")}
						>
							×
						</button>
					)}
				</div>
				{viewToggle}
				<button
					type="button"
					onClick={startCreate}
					disabled={selectableProjects.length === 0}
					className="inline-flex items-center gap-1.5 px-3 py-2 md:py-1.5 min-h-[40px] md:min-h-0 bg-accent text-white text-xs font-semibold rounded-lg hover:bg-accent-hover shadow-lg shadow-accent/20 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
					title={t("board.newTask")}
					data-testid="board-new-task"
				>
					{/* Nerd Font: fa-plus (U+F067) */}
					<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }} aria-hidden>
						{""}
					</span>
					<span>{t("board.newTask")}</span>
				</button>
			</div>

			{/* Step 1 of create-from-board: choose the target project (typeahead) */}
			{pickingProject && (
				<PaletteShell
					items={selectableProjects}
					getKey={(p) => p.id}
					getText={(p) => (isBuiltinOpsProject(p) ? t("ops.boardName") : p.name)}
					onSelect={(p) => {
						setPickingProject(false);
						openCreateTaskFor(p.id);
					}}
					onClose={() => setPickingProject(false)}
					placeholder={t("board.pickProjectPlaceholder")}
					ariaLabel={t("board.pickProjectAria")}
					hint={t("board.pickProjectHint")}
					noResults={t("board.pickProjectNoResults")}
					testId="board-project-picker"
				/>
			)}

			{/* Body */}
			{loading ? (
				<div className="flex-1 flex items-center justify-center">
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
				</div>
			) : total === 0 ? (
				<div className="flex-1 flex items-center justify-center px-6 text-center">
					<p className="text-fg-3 text-sm">{t("activity.noActiveTasks")}</p>
				</div>
			) : isCarousel ? (
				<MobileBoardCarousel columns={carouselColumns} />
			) : (
				<div className="flex-1 min-h-0 flex gap-5 p-6 overflow-x-auto overflow-y-hidden kanban-scroll">
					{BOARD_STATUSES.map((status) => (
						<BoardColumn
							key={status}
							label={t(statusKey(status))}
							color={statusColors[status]}
							tasks={tasksByStatus.get(status) ?? []}
							ctx={ctx}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export default AllTasksBoard;
