import { useState } from "react";
import type { Project, Task } from "../../shared/types";
import { getTaskTitle, isBuiltinOpsProject } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { useT } from "../i18n";
import { PaletteShell } from "./PaletteShell";

/** A palette row: either a project to jump to, or an active task to open. */
export type GoToEntry =
	| { kind: "project"; project: Project }
	| { kind: "task"; task: Task; project?: Project };

export type TaskBucket = "today" | "yesterday" | "week" | "older";

/**
 * Which recency bucket a task's `updatedAt` falls into, relative to `now`.
 * Anchored on local midnight so "today"/"yesterday" match the calendar;
 * "week" is the preceding 7-day window; everything else (incl. blank/unparsable
 * timestamps) is "older".
 */
export function taskRecencyBucket(updatedAt: string, now: number): TaskBucket {
	const ts = Date.parse(updatedAt);
	if (Number.isNaN(ts)) return "older";
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const t0 = start.getTime();
	const DAY = 86_400_000;
	if (ts >= t0) return "today";
	if (ts >= t0 - DAY) return "yesterday";
	if (ts >= t0 - 7 * DAY) return "week";
	return "older";
}

const DATE_GROUP_ORDER = ["today", "yesterday", "week", "older"];

/** The palette's active search scope. */
export type GoToMode = "projects" | "project-tasks" | "all-tasks";
const MODE_STORAGE_KEY = "dev3-gotopalette-mode";

/** Resolve the mode to open in: the last-used one if still available, else a sensible fallback. */
function resolveInitialMode(available: GoToMode[]): GoToMode {
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(MODE_STORAGE_KEY);
	} catch {
		/* private mode / no storage — fall through to default */
	}
	if (stored && available.includes(stored as GoToMode)) return stored as GoToMode;
	// Remembered a task mode but there's no current project → keep the task intent.
	if ((stored === "project-tasks" || stored === "all-tasks") && available.includes("all-tasks")) {
		return "all-tasks";
	}
	return "projects";
}

interface GoToPaletteModalProps {
	/**
	 * Non-deleted projects in display order — most-recently jumped-to first,
	 * then the rest in board order (see `orderByRecency`).
	 */
	projects: Project[];
	/** All active tasks across every project, most-recently-updated first ("All tasks" mode). */
	tasks: Task[];
	/** Active tasks of the project currently in view, most-recently-updated first ("This project" mode). */
	projectTasks: Task[];
	/** Whether a project is currently in view — gates the "This project" mode. */
	hasCurrentProject: boolean;
	/** Project lookup for the per-task project badge (All tasks mode). */
	projectById: Map<string, Project>;
	/**
	 * Project id → its 0-based BOARD index, for the ⌘N badge. Kept separate from
	 * display order so the badge keeps matching the Cmd+1..9 shortcut (which is
	 * board-order based) even after recency reorders the rows.
	 */
	shortcutIndexById?: Record<string, number>;
	onSelectProject: (projectId: string) => void;
	onSelectTask: (task: Task) => void;
	onClose: () => void;
}

/**
 * Cmd/Ctrl+K quick-switch palette (navigation). One shared shell, one active
 * MODE at a time, cycled by tapping Shift or clicking the footer mode switcher:
 *
 *   • projects       — fuzzy-jump to a project (⌘1..9 badges).
 *   • project-tasks  — active tasks of the current project (date-bucketed).
 *   • all-tasks      — active tasks across all projects (date-bucketed + project badge).
 *
 * Opens in the last-used mode (default "projects"; the "This project" mode is
 * hidden when no project is in view). The task modes bucket rows by `updatedAt`
 * into Today / Yesterday / This week / Older. Complements the Option/Ctrl+Tab
 * hold-cycle switcher (that cycles; this type-searches).
 */
function GoToPaletteModal({
	projects,
	tasks,
	projectTasks,
	hasCurrentProject,
	projectById,
	shortcutIndexById,
	onSelectProject,
	onSelectTask,
	onClose,
}: GoToPaletteModalProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const now = Date.now();

	const availableModes: GoToMode[] = hasCurrentProject
		? ["projects", "project-tasks", "all-tasks"]
		: ["projects", "all-tasks"];

	const [mode, setMode] = useState<GoToMode>(() => resolveInitialMode(availableModes));

	function selectMode(next: GoToMode) {
		setMode(next);
		try {
			localStorage.setItem(MODE_STORAGE_KEY, next);
		} catch {
			/* best-effort persistence */
		}
	}
	function cycleMode() {
		const i = availableModes.indexOf(mode);
		selectMode(availableModes[(i + 1) % availableModes.length]);
	}

	const modeLabel = (m: GoToMode) =>
		m === "projects"
			? t("goTo.modeProjects")
			: m === "project-tasks"
				? t("goTo.modeProjectTasks")
				: t("goTo.modeAllTasks");

	const isTaskMode = mode !== "projects";
	const sourceTasks = mode === "project-tasks" ? projectTasks : tasks;
	const entries: GoToEntry[] = isTaskMode
		? sourceTasks.map((task) => ({ kind: "task", task, project: projectById.get(task.projectId) }))
		: projects.map((project) => ({ kind: "project", project }));

	const bucketLabel: Record<string, string> = {
		today: t("goTo.sectionToday"),
		yesterday: t("goTo.sectionYesterday"),
		week: t("goTo.sectionWeek"),
		older: t("goTo.sectionOlder"),
	};

	// Footer mode switcher — clicking a segment jumps to that mode; onMouseDown
	// preventDefault keeps focus on the input so typing + Shift-tap keep working.
	const modeSwitcher = (
		<div className="flex items-center gap-1" role="group" aria-label={t("goTo.modeGroupLabel")}>
			{availableModes.map((m) => (
				<button
					key={m}
					type="button"
					aria-pressed={m === mode}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => selectMode(m)}
					className={`px-2 py-0.5 rounded transition-colors ${
						m === mode ? "bg-accent/15 text-accent" : "text-fg-3 hover:text-fg hover:bg-elevated-hover"
					}`}
				>
					{modeLabel(m)}
				</button>
			))}
		</div>
	);

	return (
		<PaletteShell<GoToEntry>
			items={entries}
			getKey={(e) => (e.kind === "project" ? `p:${e.project.id}` : `t:${e.task.id}`)}
			getText={(e) =>
				e.kind === "project"
					? isBuiltinOpsProject(e.project)
						? t("ops.boardName")
						: e.project.name
					: getTaskTitle(e.task)
			}
			onSelect={(e) => (e.kind === "project" ? onSelectProject(e.project.id) : onSelectTask(e.task))}
			onClose={onClose}
			placeholder={isTaskMode ? t("goTo.placeholderTasks") : t("goTo.placeholderProjects")}
			ariaLabel={t("goTo.title")}
			hint={t("goTo.hint")}
			noResults={isTaskMode ? t("goTo.noTasks") : t("goTo.noProjects")}
			testId="go-to-palette"
			footerLeft={modeSwitcher}
			onShiftTap={cycleMode}
			resetKey={mode}
			getGroup={isTaskMode ? (e) => (e.kind === "task" ? taskRecencyBucket(e.task.updatedAt, now) : "older") : undefined}
			groupOrder={isTaskMode ? DATE_GROUP_ORDER : undefined}
			groupLabel={isTaskMode ? (g) => bucketLabel[g] ?? g : undefined}
			renderItemLeft={
				isTaskMode
					? (e) =>
							e.kind === "task" ? (
								<span
									className="w-2 h-2 rounded-full flex-shrink-0"
									style={{ background: statusColors[e.task.status] }}
									aria-hidden
								/>
							) : null
					: undefined
			}
			renderItemRight={(e, _i, query) => {
				if (e.kind === "task") {
					// Project badge only in All-tasks mode (redundant when scoped to one project).
					return mode === "all-tasks" && e.project ? (
						<span className="text-fg-3 text-xs flex-shrink-0">{e.project.name}</span>
					) : null;
				}
				if (query.length === 0 && isBuiltinOpsProject(e.project)) {
					return <span className="text-fg-3 text-xs flex-shrink-0">⌘0</span>;
				}
				const idx = shortcutIndexById?.[e.project.id];
				return idx !== undefined && idx < 9 && query.length === 0 ? (
					<span className="text-fg-3 text-xs flex-shrink-0">⌘{idx + 1}</span>
				) : null;
			}}
		/>
	);
}

export default GoToPaletteModal;
