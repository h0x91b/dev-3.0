import { useRef, useState, type ReactNode } from "react";
import type { BoardColumnSlot, Label, Project, Task } from "../../../shared/types";
import { getTaskOverview, getTaskTitle, taskSeqLabel } from "../../../shared/types";
import { parentTaskIdOf } from "../../../shared/types/task-origin";
import { useT, type TranslationKey } from "../../i18n";
import LabelChip from "../../components/LabelChip";
import LabelPicker from "../../components/LabelPicker";
import PipelineDropdown from "../../components/PipelineDropdown";
import PriorityBadge from "../../components/PriorityBadge";
import StatusMenuPortal from "../../components/StatusMenuPortal";
import { TaskRefText } from "../../components/TaskRefText";
import { useStatusMenu } from "../../hooks/useStatusMenu";
import { useStatusColors } from "../../hooks/useStatusColors";
import { getStatusLabel } from "../../utils/statusLabel";
import { prStateTone } from "../../utils/prStateTone";
import { compactAge } from "../../utils/statusAge";
import { taskLastActivityMs } from "../../utils/projectActivity";
import type { BoardService } from "../board-service";
import { laneOfTask, taskPrNumber, type TableColumnId } from "./table-model";

const TASK_TYPE_KEYS = {
	coordinator: "createTask.taskTypeCoordinator",
	"pr-review": "createTask.taskTypeReview",
	"board-cleanup": "createTask.taskTypeCleanup",
} as const satisfies Record<NonNullable<Task["taskType"]>, TranslationKey>;

/** Everything a row needs that is the same for every row; built once per render of the view. */
export interface TableRowContext {
	board: BoardService;
	columns: readonly BoardColumnSlot[];
	projectById: ReadonlyMap<string, Project>;
	agentNameById: ReadonlyMap<string, string>;
	taskById: ReadonlyMap<string, Task>;
	/** Seqs more than one task on the board answers to — only those get a variant suffix. */
	sharedSeqs: ReadonlySet<number>;
	/** The project's name as the rest of the app shows it (the built-in ops board has its own). */
	projectName(projectId: string): string;
	/** A task's labels, resolved against its own project. */
	labelsOf(task: Task): Label[];
	narrow: boolean;
}

/** `#981`, or `#981-2` when other variants of 981 are on the board — the card's own rule. */
export function rowSeqLabel(task: Task, ctx: TableRowContext): string {
	return `#${ctx.sharedSeqs.has(task.seq) ? taskSeqLabel(task) : task.seq}`;
}

/**
 * Stops a control's clicks — including those bubbling out of its portaled picker,
 * which React routes through this tree — from also opening the row's task.
 */
export function CellControl({ children, className = "" }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={className}
			onClick={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
			onContextMenu={(e) => e.stopPropagation()}
		>
			{children}
		</div>
	);
}

/** A cell control looks small but answers across the row's full height, so a near miss never opens the task instead. */
const ROW_HIT_AREA = "relative after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']";

function laneOf(task: Task, ctx: TableRowContext): BoardColumnSlot | null {
	const index = laneOfTask(task, ctx.columns);
	return index >= 0 ? ctx.columns[index] : null;
}

export function StatusCell({ task, ctx }: { task: Task; ctx: TableRowContext }) {
	const t = useT();
	const colors = useStatusColors();
	const menu = useStatusMenu(ctx.narrow);
	const project = ctx.projectById.get(task.projectId);
	const lane = laneOf(task, ctx);
	const custom = lane?.type === "custom" ? lane.col : project?.customColumns?.find((c) => c.id === task.customColumnId);
	const label = custom ? custom.name : getStatusLabel(task.status, t, project);
	const color = custom ? custom.color : colors[task.status];
	return (
		<CellControl className="min-w-0">
			<button
				ref={menu.triggerRef}
				type="button"
				onClick={menu.toggle}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				aria-label={t("boardTable.changeStatus", { status: label })}
				className={`${ROW_HIT_AREA} -mx-1.5 flex max-w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-fg-2 transition-colors duration-150 hover:bg-fg/8 hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60`}
			>
				<span aria-hidden className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
				<span className="truncate" title={label}>{label}</span>
			</button>
			<StatusMenuPortal menu={menu} narrow={ctx.narrow} title={t("task.moveTo")}>
				<PipelineDropdown
					currentStatus={task.status}
					onMove={(status) => {
						menu.setOpen(false);
						void ctx.board.moveTask(task.id, { status });
					}}
					onMoveToCustomColumn={(customColumnId) => {
						menu.setOpen(false);
						void ctx.board.moveTask(task.id, { customColumnId });
					}}
					customColumns={project?.customColumns}
					currentCustomColumnId={task.customColumnId}
					project={project}
					size={ctx.narrow ? "touch" : undefined}
					hideHeader={ctx.narrow}
				/>
			</StatusMenuPortal>
		</CellControl>
	);
}

export function PriorityCell({ task, ctx }: { task: Task; ctx: TableRowContext }) {
	return (
		<CellControl>
			<PriorityBadge size="sm" className={ROW_HIT_AREA} priority={task.priority} onChange={(priority) => void ctx.board.setPriority(task.id, priority)} />
		</CellControl>
	);
}

export function LabelsCell({ task, ctx }: { task: Task; ctx: TableRowContext }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement>(null);
	const project = ctx.projectById.get(task.projectId);
	const ids = task.labelIds ?? [];
	const assigned = ctx.labelsOf(task);
	const toggle = (labelId: string) => {
		const next = ids.includes(labelId) ? ids.filter((id) => id !== labelId) : [...ids, labelId];
		void ctx.board.setLabels(task.id, next);
	};
	return (
		<CellControl className="flex min-w-0 items-center">
			<button
				ref={anchorRef}
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={t("boardTable.editLabels")}
				className={`${ROW_HIT_AREA} -mx-1 flex min-w-0 rounded-md px-1 py-0.5 transition-colors duration-150 hover:bg-fg/8 focus-visible:ring-1 focus-visible:ring-accent/60`}
			>
				<span className="flex min-w-0 items-center gap-1 overflow-hidden">
					{assigned.length === 0 ? (
						<Muted />
					) : (
						assigned.map((label) => <LabelChip key={label.id} label={label} size="xs" />)
					)}
				</span>
			</button>
			{open && anchorRef.current && project && (
				<LabelPicker
					project={project}
					onCreateLabel={(name) => ctx.board.createLabel(task.projectId, name)}
					onClose={() => setOpen(false)}
					anchorEl={anchorRef.current}
					selectedIds={ids}
					onToggle={toggle}
				/>
			)}
		</CellControl>
	);
}

/** The PR number with its GitHub state, read through the shared `pr:` tokens. */
export function PrCell({ task, ctx }: { task: Task; ctx: TableRowContext }) {
	const t = useT();
	const number = taskPrNumber(task);
	if (number === null) return null;
	const state = (["merged", "closed", "open"] as const).find((s) => ctx.board.matches(task, `pr:${s}`));
	return (
		<span className="block truncate text-xs tabular-nums text-fg-2">
			#{number}
			{state && <span className={`ml-1.5 font-medium ${prStateTone(state).text}`}>{t(`boardTable.prState.${state}`)}</span>}
		</span>
	);
}

/** The task's overview on one line; its `<seq:N>` and `<pr:N>` references stay live links. */
export function OverviewCell({ task, className = "" }: { task: Task; className?: string }) {
	const overview = getTaskOverview(task);
	if (!overview) return null;
	return (
		<span title={overview} className={`text-xs text-fg-2 ${className}`}>
			<TaskRefText text={overview} contextProjectId={task.projectId} taskId={task.id} />
		</span>
	);
}

/** Only the editable Labels cell marks "none": an empty read-only cell is quieter left blank. */
function Muted() {
	return <span className="text-xs text-fg-muted">—</span>;
}

function Text({ children, mono = false, numeric = false, title }: { children: ReactNode; mono?: boolean; numeric?: boolean; title?: string }) {
	return <span title={title} className={`block truncate text-xs text-fg-2 ${mono ? "font-mono" : ""} ${numeric ? "tabular-nums" : ""}`}>{children}</span>;
}

/** One cell's content. The interactive ones own their pickers; the rest are plain text. */
export function TableCell({ column, task, ctx }: { column: TableColumnId; task: Task; ctx: TableRowContext }) {
	const t = useT();
	switch (column) {
		case "seq":
			return <span className="text-xs tabular-nums text-fg-3">{rowSeqLabel(task, ctx)}</span>;
		case "title":
			return <span className="block truncate text-sm text-fg" title={getTaskTitle(task)}>{getTaskTitle(task)}</span>;
		case "project":
			return <Text title={ctx.projectName(task.projectId)}>{ctx.projectName(task.projectId)}</Text>;
		case "status":
			return <StatusCell task={task} ctx={ctx} />;
		case "priority":
			return <PriorityCell task={task} ctx={ctx} />;
		case "labels":
			return <LabelsCell task={task} ctx={ctx} />;
		case "agent": {
			const name = task.agentId ? ctx.agentNameById.get(task.agentId) : undefined;
			return name ? <Text title={name}>{name}</Text> : null;
		}
		case "pr":
			return <PrCell task={task} ctx={ctx} />;
		case "activity": {
			const ms = taskLastActivityMs(task);
			if (!ms) return null;
			const iso = new Date(ms).toISOString();
			return <Text numeric title={new Date(ms).toLocaleString()}>{compactAge(iso)}</Text>;
		}
		case "parent": {
			const parentId = parentTaskIdOf(task);
			if (!parentId) return null;
			const parent = ctx.taskById.get(parentId);
			return parent ? <Text numeric title={getTaskTitle(parent)}>{rowSeqLabel(parent, ctx)}</Text> : <Text>{t("boardTable.parentElsewhere")}</Text>;
		}
		case "created":
			return <Text numeric title={new Date(task.createdAt).toLocaleString()}>{new Date(task.createdAt).toLocaleDateString()}</Text>;
		case "branch":
			return task.branchName ? <Text mono title={task.branchName}>{task.branchName}</Text> : null;
		case "type":
			return task.taskType ? <Text>{t(TASK_TYPE_KEYS[task.taskType])}</Text> : null;
	}
}
