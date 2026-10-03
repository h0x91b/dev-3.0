import type { Project, Task, TaskStatus } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { useT } from "../i18n";
import type { CoordinatorCandidate } from "../utils/coordinatorFinder";
import { getStatusLabel } from "../utils/statusLabel";

interface DashboardCoordinatorRowsProps {
	project: Project;
	/** Already ordered: live → no session → hibernated (see `coordinatorCandidates`). */
	coordinators: CoordinatorCandidate[];
	narrow: boolean;
	statusColors: Record<TaskStatus, string>;
	bellCounts: Map<string, number>;
	maskClass: string;
	timeAgo: (isoDate: string | undefined) => string;
	/** Navigates to the task. Never launches, wakes or moves it. */
	onOpen: (task: Task) => void;
}

const WORKING_STATUSES: TaskStatus[] = ["in-progress", "review-by-ai"];

const STATE_BADGE = "inline-flex flex-shrink-0 items-center rounded border border-dashed border-edge-active px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] text-fg-3";

/**
 * A project's coordinators, pinned above its attention rows whatever their
 * status: the user opens a coordinator to talk to the whole project, so a
 * working one must not fold into the footer's "N agents working". Navigation
 * only — no ✓, a coordinator's completion is always the user's deliberate call.
 */
function DashboardCoordinatorRows({ project, coordinators, narrow, statusColors, bellCounts, maskClass, timeAgo, onOpen }: DashboardCoordinatorRowsProps) {
	const t = useT();
	if (coordinators.length === 0) return null;
	const columnById = new Map((project.customColumns ?? []).map((c) => [c.id, c] as const));

	return (
		<div role="group" aria-label={t("activity.coordinatorsGroup")} data-testid={`dashboard-coordinators-${project.id}`} className="border-b border-edge last:border-b-0">
			{coordinators.map(({ task, state }) => {
				const column = task.customColumnId ? columnById.get(task.customColumnId) ?? null : null;
				const label = column ? column.name : getStatusLabel(task.status, t, project);
				const color = column ? column.color : statusColors[task.status];
				const parked = state === "hibernated" || state === "disconnected";
				// "Agent is Working" on a parked coordinator advertises an agent that is not
				// there; the badge already says what it is. Waiting statuses stay true.
				const showLabel = column !== null || !parked || !WORKING_STATUSES.includes(task.status);
				return (
					<button
						key={task.id}
						type="button"
						data-testid="dashboard-coordinator-row"
						data-coordinator-state={state}
						data-hint-id={`task:${task.id}`}
						onClick={() => onOpen(task)}
						className={`relative w-full flex items-start md:items-center gap-3 pl-3 md:pl-5 pr-3 md:pr-10 py-3 md:py-2.5 min-h-[44px] text-left bg-success/[0.04] hover:bg-raised-hover transition-colors border-b border-edge last:border-b-0 ${parked ? "grayscale" : ""}`}
					>
						{/* md:pr-10 = an ordinary row's pr-1 + its w-9 ✓ slot, so the status and
						    age columns line up with the rows below. */}
						{/* Identity strip in the coordinator green the board card's dashed border uses. */}
						<span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-0.5 bg-success/70" />
						<span className={`inline-flex flex-shrink-0 items-center rounded border border-dashed border-success/60 px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] text-success-strong ${narrow ? "mt-0.5" : ""}`}>
							{t("task.coordinatorBadge")}
						</span>
						<span className="min-w-0 flex-1 flex flex-col md:flex-row md:items-center gap-0.5 md:gap-3">
							<span
								title={getTaskTitle(task)}
								className={`text-fg text-sm font-medium min-w-0 md:flex-1 select-text ${narrow ? "line-clamp-2" : "truncate"} ${maskClass}`}
							>
								{getTaskTitle(task)}
							</span>
							<span className="flex items-center gap-2 md:gap-3 flex-shrink-0">
								{state === "hibernated" && <span className={STATE_BADGE}>{t("task.hibernatedBadge")}</span>}
								{state === "disconnected" && (
									<span title={t("task.disconnectedHint")} className={STATE_BADGE}>{t("task.disconnectedBadge")}</span>
								)}
								{bellCounts.has(task.id) && (
									<>
										<span className="sr-only">{t.plural("activity.unreadUpdates", bellCounts.get(task.id) ?? 1)}</span>
										<span aria-hidden="true" className="w-2 h-2 rounded-full bg-accent motion-safe:animate-pulse flex-shrink-0" />
									</>
								)}
								{!showLabel ? null : column ? (
									<span className="flex items-center gap-1.5 min-w-0 flex-shrink">
										<span aria-hidden="true" className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
										<span className="text-fg-3 text-xs truncate max-w-[8rem]" title={label}>{label}</span>
									</span>
								) : (
									<span className="text-xs flex-shrink-0" style={{ color }}>{label}</span>
								)}
								{task.movedAt && (
									<span className="text-fg-3 text-xs flex-shrink-0 tabular-nums whitespace-nowrap md:w-16 md:text-right">
										{timeAgo(task.movedAt)}
									</span>
								)}
							</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}

export default DashboardCoordinatorRows;
