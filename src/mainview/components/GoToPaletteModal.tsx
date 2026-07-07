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

const DATE_ORDER = ["today", "yesterday", "week", "older"];
// "Both" mode: tasks (date-bucketed) first, then a Projects section.
const MIXED_ORDER = [...DATE_ORDER, "projects"];

/** The palette's active search scope. */
export type GoToMode = "projects" | "mixed" | "tasks";
const MODES: GoToMode[] = ["projects", "mixed", "tasks"];
const MODE_STORAGE_KEY = "dev3-gotopalette-mode";

/** Resolve the mode to open in: the last-used one, else the default (projects). */
function resolveInitialMode(): GoToMode {
	try {
		const stored = localStorage.getItem(MODE_STORAGE_KEY);
		if (stored && (MODES as string[]).includes(stored)) return stored as GoToMode;
	} catch {
		/* private mode / no storage — fall through to default */
	}
	return "projects";
}

interface GoToPaletteModalProps {
	/**
	 * Non-deleted projects in display order — most-recently jumped-to first,
	 * then the rest in board order (see `orderByRecency`).
	 */
	projects: Project[];
	/** All active tasks across every project, most-recently-updated first. */
	tasks: Task[];
	/** Project lookup for the per-task project badge. */
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
 *   • projects — fuzzy-jump to a project (⌘1..9 badges).
 *   • mixed    — projects AND tasks together (tasks date-bucketed, then a Projects section).
 *   • tasks    — active tasks across all projects (date-bucketed).
 *
 * Opens in the last-used mode (default "projects"). Task rows carry a status dot
 * and (outside a single project) a project badge; task groups bucket by
 * `updatedAt` into Today / Yesterday / This week / Older. Complements the
 * Option/Ctrl+Tab hold-cycle switcher (that cycles; this type-searches).
 */
function GoToPaletteModal({
	projects,
	tasks,
	projectById,
	shortcutIndexById,
	onSelectProject,
	onSelectTask,
	onClose,
}: GoToPaletteModalProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const now = Date.now();

	const [mode, setMode] = useState<GoToMode>(resolveInitialMode);

	function selectMode(next: GoToMode) {
		setMode(next);
		try {
			localStorage.setItem(MODE_STORAGE_KEY, next);
		} catch {
			/* best-effort persistence */
		}
	}
	function cycleMode() {
		selectMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
	}

	const modeLabel = (m: GoToMode) =>
		m === "projects" ? t("goTo.modeProjects") : m === "mixed" ? t("goTo.modeMixed") : t("goTo.modeTasks");

	const showProjects = mode !== "tasks";
	const showTasks = mode !== "projects";
	const grouped = showTasks; // both "mixed" and "tasks" bucket tasks by date

	// Entries: tasks first (so they lead the date buckets), then projects.
	const entries: GoToEntry[] = [
		...(showTasks ? tasks.map((task) => ({ kind: "task" as const, task, project: projectById.get(task.projectId) })) : []),
		...(showProjects ? projects.map((project) => ({ kind: "project" as const, project })) : []),
	];

	const bucketLabel: Record<string, string> = {
		today: t("goTo.sectionToday"),
		yesterday: t("goTo.sectionYesterday"),
		week: t("goTo.sectionWeek"),
		older: t("goTo.sectionOlder"),
		projects: t("goTo.sectionProjects"),
	};

	// Footer mode switcher — clicking a segment jumps to that mode; onMouseDown
	// preventDefault keeps focus on the input so typing + Shift-tap keep working.
	const modeSwitcher = (
		<div className="flex items-center gap-1" role="group" aria-label={t("goTo.modeGroupLabel")}>
			{MODES.map((m) => (
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
			placeholder={mode === "projects" ? t("goTo.placeholderProjects") : mode === "tasks" ? t("goTo.placeholderTasks") : t("goTo.placeholderMixed")}
			ariaLabel={t("goTo.title")}
			hint={t("goTo.hint")}
			noResults={mode === "projects" ? t("goTo.noProjects") : mode === "tasks" ? t("goTo.noTasks") : t("goTo.noMixed")}
			testId="go-to-palette"
			footerLeft={modeSwitcher}
			onShiftTap={cycleMode}
			resetKey={mode}
			getGroup={grouped ? (e) => (e.kind === "task" ? taskRecencyBucket(e.task.updatedAt, now) : "projects") : undefined}
			groupOrder={grouped ? (mode === "mixed" ? MIXED_ORDER : DATE_ORDER) : undefined}
			groupLabel={grouped ? (g) => bucketLabel[g] ?? g : undefined}
			renderItemLeft={
				grouped
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
					return e.project ? <span className="text-fg-3 text-xs flex-shrink-0">{e.project.name}</span> : null;
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
