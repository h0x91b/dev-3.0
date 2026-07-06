import type { Project, Task } from "../../shared/types";
import { getTaskTitle, isBuiltinOpsProject } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import { useT } from "../i18n";
import { PaletteShell } from "./PaletteShell";

/** A palette row: either a project to jump to, or an active task to open. */
export type GoToEntry =
	| { kind: "project"; project: Project }
	| { kind: "task"; task: Task; project?: Project };

const GROUP_ORDER = ["project", "task"];

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
 * Cmd/Ctrl+K quick-switch palette (navigation). One shared shell lists two
 * sections: **Projects** (fuzzy-jump by name, ⌘N badge mirrors Cmd+1..9) and
 * **Tasks** (all active tasks across projects, most-recently-visited first).
 * Type to fuzzy-filter both; Enter opens the highlighted match. This realizes
 * the manifest's "Cmd+K absorbs task search" direction — the type-search
 * counterpart to the Option/Ctrl+Tab hold-cycle task switcher.
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
			getGroup={(e) => e.kind}
			groupOrder={GROUP_ORDER}
			groupLabel={(g) => (g === "project" ? t("goTo.sectionProjects") : t("goTo.sectionTasks"))}
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
