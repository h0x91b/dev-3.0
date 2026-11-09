import type { SVGProps } from "react";
import type { Task } from "../../shared/types";
import { isCoordinatorTask } from "../../shared/types";
import { useT } from "../i18n";
import { ChildTasksIcon } from "./LineageIcons";
import Tooltip from "./Tooltip";

/**
 * A task role (coordinator, board cleanup) is named by an opaque band, not a hue:
 * the band changes the card's silhouette, so it is found by shape at board scale.
 * See decisions/2026/11/06/coordinator-role-band-not-a-hue.md.
 */
export type TaskRole = "coordinator" | "board-cleanup";

export function taskRole(task: Pick<Task, "taskType">): TaskRole | null {
	if (isCoordinatorTask(task)) return "coordinator";
	return task.taskType === "board-cleanup" ? "board-cleanup" : null;
}

/** Layered accent halo for a coordinator card; replaces a second identity border. Hover deepens it like any card's lift. */
export const COORDINATOR_CARD_HALO =
	"shadow-[0_0_0_1px_rgb(var(--accent)/0.5),0_6px_18px_-6px_rgb(var(--accent)/0.45)] hover:shadow-[shadow:0_0_0_1px_rgb(var(--accent)/0.6),0_10px_24px_-6px_rgb(var(--accent)/0.55),var(--shadow-card-hover)]";

/** A coordinator's title in rows (dashboard, switcher, sidebar); board cleanup stays neutral like its band. */
export const COORDINATOR_TITLE = "text-accent-emphasis";

const FILL: Record<TaskRole, string> = {
	coordinator: "bg-accent-fill text-white",
	// Measured: bg-elevated is Lc 0 against the card in both themes; fg/30 is the neutral that clears 15.
	"board-cleanup": "bg-fg/30 text-fg",
};

const LABEL_KEY = { coordinator: "task.coordinatorBadge", "board-cleanup": "task.boardCleanupBadge" } as const;
const HINT_KEY = { coordinator: "task.coordinatorHint", "board-cleanup": "task.boardCleanupHint" } as const;

function glyphProps(className: string): SVGProps<SVGSVGElement> {
	return {
		className,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2.2,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
	};
}

export function RoleGlyph({ role, className }: { role: TaskRole; className: string }) {
	if (role === "coordinator") {
		return (
			<svg {...glyphProps(className)}>
				<circle cx="12" cy="12" r="2.2" />
				<circle cx="12" cy="4.5" r="1.6" />
				<circle cx="5.2" cy="17" r="1.6" />
				<circle cx="18.8" cy="17" r="1.6" />
				<path d="M12 9.8V6.1M10.3 13.3l-3.6 2.5M13.7 13.3l3.6 2.5" />
			</svg>
		);
	}
	return (
		<svg {...glyphProps(className)}>
			<path d="M19 3l-7.5 7.5" />
			<path d="M9.5 9.5l5 5-2 6.5c-3-.5-6.5-2.5-8.5-5.5l5.5-6z" />
			<path d="M7 17.5l2.5-2.5" />
		</svg>
	);
}

/** The card's role band: glyph + role name, and for a coordinator the tasks it created. */
export function TaskRoleBand({ role, childCount = 0, onFilterByChildren }: { role: TaskRole; childCount?: number; onFilterByChildren?: () => void }) {
	const t = useT();
	return (
		<div
			data-testid="task-role-band"
			data-role={role}
			// Flush under the status strip, so strip and band read as one block; the left rail still names the status.
			className={`flex h-[22px] flex-shrink-0 items-center gap-1.5 pl-[9px] pr-2.5 text-dense font-semibold uppercase tracking-[0.08em] ${FILL[role]}`}
		>
			<Tooltip content={t(LABEL_KEY[role])} detail={t(HINT_KEY[role])}>
				<span className="inline-flex min-w-0 items-center gap-1.5">
					<RoleGlyph role={role} className="h-3 w-3 flex-shrink-0" />
					<span className="truncate">{t(LABEL_KEY[role])}</span>
				</span>
			</Tooltip>
			{role === "coordinator" && childCount > 0 && (
				<Tooltip content={t.plural("task.lineage.children", childCount)} detail={t("task.lineage.filterHint")}>
					<button
						type="button"
						data-testid="task-role-band-count"
						aria-label={t.plural("task.lineage.children", childCount)}
						disabled={!onFilterByChildren}
						onClick={(event) => {
							event.stopPropagation();
							onFilterByChildren?.();
						}}
						className="ml-auto inline-flex flex-shrink-0 items-center gap-1 rounded normal-case tracking-[0.02em] tabular-nums opacity-90 hover:opacity-100 focus-visible:ring-1 focus-visible:ring-white"
					>
						<ChildTasksIcon className="h-3 w-3 flex-shrink-0" />
						{t.plural("task.lineage.created", childCount)}
					</button>
				</Tooltip>
			)}
		</div>
	);
}

/** Filled role chip for one-line rows (sidebar, dashboard), where a band has no room. */
export function TaskRoleChip({ role, testId, className = "" }: { role: TaskRole; testId?: string; className?: string }) {
	const t = useT();
	return (
		<span
			data-testid={testId}
			title={t(HINT_KEY[role])}
			className={`inline-flex flex-shrink-0 items-center gap-1 rounded px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] ${FILL[role]} ${className}`}
		>
			<RoleGlyph role={role} className="h-2.5 w-2.5 flex-shrink-0" />
			{t(LABEL_KEY[role])}
		</span>
	);
}
