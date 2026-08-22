import { useState, type Dispatch } from "react";
import type { CodingAgent, Label, PortInfo, Project, Task, TaskPriority, TaskStatus } from "../../shared/types";
import { getAllowedTransitions, getTaskTitle, isCoordinatorTask, isTaskDisconnected } from "../../shared/types";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT, useLocale } from "../i18n";
import { useStatusMenu } from "../hooks/useStatusMenu";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { ageParts, compactAge, type AgeUnit } from "../utils/statusAge";
import type { AppAction, Route } from "../state";
import AgentLauncherBadge from "./AgentLauncherBadge";
import LabelChip from "./LabelChip";
import NativeBackendMark, { isNativeBackendTask } from "./NativeBackendMark";
import PipelineDropdown from "./PipelineDropdown";
import PriorityBadge from "./PriorityBadge";
import StatusMenuPortal from "./StatusMenuPortal";
import TaskCardRail from "./TaskCardRail";
import TaskShutdownOverlay from "./TaskShutdownOverlay";
import Tooltip from "./Tooltip";
import VariantDots from "./VariantDots";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

/** Maps the single most-significant age unit to its verbose i18n key. */
const AGE_UNIT_KEY: Record<AgeUnit, string> = {
	s: "activity.secondsAgo",
	m: "activity.minutesAgo",
	h: "activity.hoursAgo",
	d: "activity.daysAgo",
	M: "activity.monthsAgo",
	y: "activity.yearsAgo",
};

interface ActiveTaskRowProps {
	task: Task;
	/** The task's OWN project — custom columns and labels resolve against it. */
	taskProject: Project;
	isActive: boolean;
	bellCount: number;
	agent?: CodingAgent | null;
	agents: CodingAgent[];
	configLabel?: string;
	assignedLabels: Label[];
	groupMembers: Task[];
	projectBadgeName?: string;
	ports?: PortInfo[];
	statusColors: Record<TaskStatus, string>;
	/** Custom-column colour when parked in one, else the built-in status hue. */
	color: string;
	/** Shared clock tick so every row's age badge updates on the same frame. */
	now: number;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	onOpen: () => void;
	onSetPriority: (priority: TaskPriority) => void;
	onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => void;
	onMouseLeave: () => void;
	/** Closes the hover terminal preview before navigating away. */
	closePreview: () => void;
}

/**
 * One row of the Active Tasks sidebar. Carries the same LIFECYCLE rail as the
 * Kanban card (`TaskCardRail`) so one vocabulary covers both surfaces, then
 * title → signals → a muted identity line: the agent config is the least
 * discriminating thing on the row and no longer opens it.
 */
export default function ActiveTaskRow({
	task,
	taskProject,
	isActive,
	bellCount,
	agent,
	agents,
	configLabel,
	assignedLabels,
	groupMembers,
	projectBadgeName,
	ports,
	statusColors,
	color,
	now,
	dispatch,
	navigate,
	onOpen,
	onSetPriority,
	onMouseEnter,
	onMouseLeave,
	closePreview,
}: ActiveTaskRowProps) {
	const t = useT();
	const [locale] = useLocale();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const statusMenu = useStatusMenu(narrow);
	const [completing, setCompleting] = useState(false);
	const [moving, setMoving] = useState(false);

	const displayTitle = getTaskTitle(task);
	const agentSummary = [agent?.name, configLabel].filter(Boolean).join(" · ");
	const disabled = task.shuttingDown || task.preparing || task.hibernated || moving;
	// Session gone with the app; the row still opens (that is where recovery is
	// offered), it just stops counting as one of the sessions running right now.
	const disconnected = isTaskDisconnected(task);
	const activeCol = task.customColumnId
		? (taskProject.customColumns ?? []).find((c) => c.id === task.customColumnId)
		: null;
	// Busy statuses keep the flowing highlight the thin rail used to carry — the
	// ring reports the stage, not that an agent is moving right now.
	const isBusy = (task.status === "in-progress" || task.status === "review-by-ai") && !disconnected;

	async function handleMove(newStatus: TaskStatus, opts?: { alwaysConfirm?: boolean }) {
		statusMenu.setOpen(false);
		await moveTaskToStatus({
			task,
			project: taskProject,
			newStatus,
			dispatch,
			t,
			onOpenTask: onOpen,
			alwaysConfirm: opts?.alwaysConfirm,
			onMovingChange: setMoving,
		});
	}

	async function handleMoveToCustomColumn(customColumnId: string) {
		statusMenu.setOpen(false);
		setMoving(true);
		try {
			const updated = await api.request.moveTaskToCustomColumn({
				taskId: task.id,
				projectId: taskProject.id,
				customColumnId,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
		}
		setMoving(false);
	}

	// The ✓ acknowledges the click on the same tick — the dialog it opens still
	// has a git check streaming into it, so silence here reads as a dead button.
	async function handleComplete(e: React.MouseEvent) {
		e.stopPropagation();
		setCompleting(true);
		try {
			await handleMove("completed", { alwaysConfirm: true });
		} finally {
			setCompleting(false);
		}
	}

	const agePart = ageParts(task.movedAt, now);

	return (
		<div
			data-hint-id={`task:${task.id}`}
			role="button"
			tabIndex={task.shuttingDown ? -1 : 0}
			aria-disabled={task.shuttingDown || undefined}
			// The row's explicit name overrides its descendants, so the native
			// marker only reaches assistive tech from here.
			aria-label={
				isNativeBackendTask(task) ? `${displayTitle} — ${t("task.nativeBackendMark")}` : displayTitle
			}
			onClick={onOpen}
			onKeyDown={(e) => {
				// Row is a div (so the nested buttons are valid HTML); restore
				// native button keyboard activation.
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			onMouseEnter={(e) => {
				if (!task.shuttingDown) onMouseEnter(e);
			}}
			onMouseLeave={onMouseLeave}
			className={`relative flex w-full items-stretch text-left transition-colors cursor-pointer focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
				task.shuttingDown
					? "grayscale opacity-40 pointer-events-none"
					: task.hibernated || disconnected
						? "grayscale opacity-60 hover:bg-elevated-hover"
						: isActive
							? "bg-accent/20 ring-1 ring-inset ring-accent/50"
							: "hover:bg-elevated-hover"
			}`}
		>
			{/* Faint status wash so the whole row carries its column color
			    (non-active rows only; active keeps its accent tint). */}
			{!isActive && (
				<span className="absolute inset-0 pointer-events-none" style={{ background: `${color}0f` }} />
			)}

			{/* LIFECYCLE — the board's rail, unchanged. Wrapped so the busy flow can
			    sheen over it without forking the component. */}
			<span className="relative flex flex-shrink-0 overflow-hidden" data-testid={`sidebar-status-rail-${task.id}`}>
				<TaskCardRail
					status={task.status}
					project={taskProject}
					customColumn={activeCol ? { name: activeCol.name, color: activeCol.color } : null}
					color={color}
					bellCount={bellCount}
					disabled={disabled}
					canComplete={!disabled && getAllowedTransitions(task.status).includes("completed")}
					completing={completing}
					onOpenMenu={statusMenu.toggle}
					onComplete={handleComplete}
					menuTriggerRef={statusMenu.triggerRef}
					touch={narrow}
					autoLabel
				/>
				{isBusy && (
					<span
						aria-hidden
						className="pointer-events-none absolute inset-x-0 h-1/2 animate-rail-flow motion-reduce:animate-none"
						style={{ background: `linear-gradient(180deg, transparent, ${color}, transparent)`, opacity: 0.45 }}
					/>
				)}
			</span>

			{task.shuttingDown && <TaskShutdownOverlay />}

			<div className="min-w-0 flex-1 px-2.5 py-2">
				{/* Project badge (global/attention scope only) */}
				{projectBadgeName && (
					<Tooltip content={projectBadgeName}>
						<div
							className="mb-1 inline-flex items-center gap-1 max-w-full text-micro font-semibold text-accent bg-accent/10 border border-accent/25 rounded px-1.5 py-[1px]"
							data-testid={`sidebar-project-badge-${task.id}`}
						>
							<span
								aria-hidden
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
								className="leading-none text-xs"
							>
								{""}
							</span>
							<span className="truncate">{projectBadgeName}</span>
						</div>
					</Tooltip>
				)}

				{/* CONTENT — the row's only visual focus. */}
				<div className={`text-xs leading-snug break-words ${isActive ? "text-fg font-medium" : "text-fg-2"}`}>
					{displayTitle}
				</div>

				{/* Overview — shown only for the active task, and only if set. The
				    user's manual edit (`userOverview`) overrides the agent's
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

				{/* SIGNALS — read-only facts, plus the priority picker. */}
				<div className="mt-1.5 flex items-center gap-1 min-w-0 flex-wrap">
					<PriorityBadge priority={task.priority} onChange={onSetPriority} />
					<div className="text-nano text-fg-3 font-mono shrink-0">#{task.seq}</div>
					{assignedLabels.length > 0 && (
						<div className="flex flex-wrap gap-0.5 min-w-0">
							{assignedLabels.map((label) => (
								<LabelChip key={label.id} label={label} size="xs" />
							))}
						</div>
					)}
					<VariantDots
						groupMembers={groupMembers}
						currentTaskId={task.id}
						statusColors={statusColors}
						agents={agents}
						navigate={navigate}
						projectId={taskProject.id}
						onOpen={closePreview}
						size="sm"
						testId={`variant-indicator-${task.id}`}
					/>
					{agePart && (
						<Tooltip
							content={t("sidebar.statusChanged", {
								ago:
									agePart.unit === "s" && agePart.value < 1
										? t("activity.justNow")
										: t(AGE_UNIT_KEY[agePart.unit] as Parameters<typeof t>[0], {
												count: String(agePart.value),
											}),
								date: new Date(task.movedAt!).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
							})}
						>
							<span
								className="ml-auto shrink-0 flex items-center gap-0.5 text-nano text-fg-3 font-mono whitespace-nowrap"
								data-testid={`sidebar-status-age-${task.id}`}
							>
								<span aria-hidden className="leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
									{""}
								</span>
								{compactAge(task.movedAt, now)}
							</span>
						</Tooltip>
					)}
				</div>

				{/* IDENTITY — one muted line, last. Same order as the card: the
				    backend qualifies the task, so it precedes the agent badge. */}
				<Tooltip content={agentSummary} disabled={!agentSummary}>
					<div className="mt-1 flex items-center gap-1.5 min-w-0" data-testid={`sidebar-identity-${task.id}`}>
						<NativeBackendMark task={task} className="w-3 h-3" testId={`sidebar-native-backend-${task.id}`} />
						{agent && <AgentLauncherBadge agent={agent} size={12} />}
						{isCoordinatorTask(task) && (
							<span
								data-testid="sidebar-coordinator-badge"
								title={t("task.coordinatorHint")}
								className="inline-flex flex-shrink-0 items-center rounded border border-dashed border-success/60 px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] text-success-strong"
							>
								{t("task.coordinatorBadge")}
							</span>
						)}
						{task.taskType === "pr-review" && (
							<span
								data-testid="sidebar-pr-review-badge"
								title={t("task.prReviewHint")}
								className="inline-flex flex-shrink-0 items-center text-nano font-semibold uppercase tracking-[0.06em] text-fg-3"
							>
								{t("task.prReviewBadge")}
							</span>
						)}
						{task.hibernated && (
							<span
								data-testid="sidebar-hibernated-badge"
								title={t("task.hibernatedHint")}
								className="inline-flex flex-shrink-0 items-center rounded border border-dashed border-edge-active px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] text-fg-muted"
							>
								{t("task.hibernatedBadge")}
							</span>
						)}
						{disconnected && (
							<span
								data-testid="sidebar-disconnected-badge"
								title={t("task.disconnectedHint")}
								className="inline-flex flex-shrink-0 items-center rounded border border-dashed border-edge-active px-1 py-px text-nano font-semibold uppercase tracking-[0.06em] text-fg-muted"
							>
								{t("task.disconnectedBadge")}
							</span>
						)}
						<div className="min-w-0 flex-1 truncate text-nano font-mono text-fg-muted">{agentSummary}</div>
					</div>
				</Tooltip>

				{/* Port indicators */}
				{ports && ports.length > 0 && (
					<div className="flex flex-wrap gap-1 mt-1">
						{ports.map((p) => (
							<Tooltip key={p.port} content={`${p.processName} (PID ${p.pid})`}>
								<span
									className="inline-flex items-center gap-1 text-nano font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded"
									onClick={(e) => {
										e.stopPropagation();
										window.open(`http://localhost:${p.port}`, "_blank");
									}}
								>
									<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>:{p.port}
								</span>
							</Tooltip>
						))}
					</div>
				)}
			</div>

			<StatusMenuPortal
				menu={statusMenu}
				narrow={narrow}
				title={t("task.moveTo")}
				sheetTestId={`sidebar-status-sheet-${task.id}`}
			>
				<PipelineDropdown
					currentStatus={task.status}
					onMove={handleMove}
					onMoveToCustomColumn={handleMoveToCustomColumn}
					customColumns={taskProject.customColumns}
					currentCustomColumnId={task.customColumnId}
					project={taskProject}
					size={narrow ? "touch" : undefined}
					hideHeader={narrow}
				/>
			</StatusMenuPortal>
		</div>
	);
}
