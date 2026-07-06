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

// Tasks first (bucketed by recency), then projects. Empty buckets render no
// header (PaletteShell only draws a header before a group that has rows).
const GROUP_ORDER = ["today", "yesterday", "week", "older", "project"];

interface GoToPaletteModalProps {
	/**
	 * Non-deleted projects in display order — most-recently jumped-to first,
	 * then the rest in board order (see `orderByRecency`).
	 */
	projects: Project[];
	/** Active tasks across all projects, most-recently-visited first (MRU). */
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
 * Cmd/Ctrl+K quick-switch palette (navigation). One shared shell lists tasks
 * first — every active task across all projects, bucketed by `updatedAt` into
 * **Today / Yesterday / This week / Older** (most-recent first within each) —
 * then a **Projects** section (fuzzy-jump by name, ⌘N badge mirrors Cmd+1..9).
 * Type to fuzzy-filter everything; Enter opens the highlighted match. This
 * realizes the manifest's "Cmd+K absorbs task search" direction — the
 * type-search counterpart to the Option/Ctrl+Tab hold-cycle task switcher.
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

	const bucketLabel: Record<string, string> = {
		today: t("goTo.sectionToday"),
		yesterday: t("goTo.sectionYesterday"),
		week: t("goTo.sectionWeek"),
		older: t("goTo.sectionOlder"),
		project: t("goTo.sectionProjects"),
	};

	const entries: GoToEntry[] = [
		...projects.map((project) => ({ kind: "project" as const, project })),
		...tasks.map((task) => ({ kind: "task" as const, task, project: projectById.get(task.projectId) })),
	];

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
			placeholder={t("goTo.placeholder")}
			ariaLabel={t("goTo.title")}
			hint={t("goTo.hint")}
			noResults={t("goTo.noResults")}
			testId="go-to-palette"
			getGroup={(e) => (e.kind === "task" ? taskRecencyBucket(e.task.updatedAt, now) : "project")}
			groupOrder={GROUP_ORDER}
			groupLabel={(g) => bucketLabel[g] ?? g}
			renderItemLeft={(e) =>
				e.kind === "task" ? (
					<span
						className="w-2 h-2 rounded-full flex-shrink-0"
						style={{ background: statusColors[e.task.status] }}
						aria-hidden
					/>
				) : null
			}
			renderItemRight={(e, _i, query) => {
				if (e.kind === "task") {
					return e.project ? (
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
