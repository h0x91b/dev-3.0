import type { Context, Fiber } from "cordis";
import { createContext, useContext } from "react";
import { getTaskTitle } from "../../shared/types";
import { allPullRequests } from "../../shared/task-pull-requests";
import { NoteItem, formatDate } from "../components/NoteItem";
import { TaskDescriptionMarkdown } from "../components/pr-review/markdown";
import SharedOutputsList from "../components/SharedOutputsList";
import TaskEpicRow from "../components/TaskEpicRow";
import TaskOriginRow from "../components/TaskOriginRow";
import { useT } from "../i18n";
import type { BuiltinPlugin } from "../plugins/runtime";
import { prDisplayState, prStateTone } from "../utils/prStateTone";
// Defines the slot before the plugin injects it.
import "./registry";
import type { TaskDetailItemProps, TaskDetailSectionItem } from "./registry";

export const TASK_DETAIL_SECTIONS_BUILTIN_ID = "builtin:task-detail-sections";

/** Note editing, for the built-in Notes section only: the scope every item sees stays read-only. */
export interface TaskDetailNoteActions {
	onAddNote: () => void;
	onUpdateNote: (noteId: string, content: string) => void;
	onDeleteNote: (noteId: string) => void;
}

export const TaskDetailNoteActionsContext = createContext<TaskDetailNoteActions | null>(null);

function SharedOutputs({ task, project }: TaskDetailItemProps) {
	return <SharedOutputsList task={task} projectId={project.id} />;
}

function Description({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<div className="mb-6">
			<span className="text-fg-3 text-xs font-medium uppercase tracking-wider mb-2 block">
				{t("task.descriptionLabel")}
			</span>
			<TaskDescriptionMarkdown body={task.description} projectId={task.projectId} taskId={task.id} />
		</div>
	);
}

function Notes({ task }: TaskDetailItemProps) {
	const t = useT();
	const actions = useContext(TaskDetailNoteActionsContext);
	if (!actions) throw new Error("Notes rendered outside a task detail view");
	return (
		<div className="border-t border-edge pt-4">
			<div className="flex items-center justify-between mb-3">
				<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">
					{t("notes.title")}
				</span>
				<button
					onClick={actions.onAddNote}
					className="text-xs text-accent hover:text-accent-emphasis transition-colors"
				>
					{t("notes.add")}
				</button>
			</div>
			{(task.notes ?? []).length === 0 && (
				<span className="text-xs text-fg-muted">{t("notes.empty")}</span>
			)}
			{(task.notes ?? []).map(note => (
				<NoteItem
					key={note.id}
					note={note}
					taskId={task.id}
					onSave={(content) => actions.onUpdateNote(note.id, content)}
					onDelete={() => actions.onDeleteNote(note.id)}
					clamp
				/>
			))}
		</div>
	);
}

function SeqRow({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<>
			<span className="text-fg-3">{t("infoPanel.taskNumber")}</span>
			<span className="text-fg-2 font-mono font-semibold">#{task.seq}</span>
		</>
	);
}

function BranchRow({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<>
			<span className="text-fg-3">{t("infoPanel.branch")}</span>
			<span className="text-fg-2 font-mono truncate">{task.branchName}</span>
		</>
	);
}

function BaseBranchRow({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<>
			<span className="text-fg-3">{t("infoPanel.baseBranch")}</span>
			<span className="text-fg-2 font-mono">{task.baseBranch}</span>
		</>
	);
}

function PullRequestsRow({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<>
			<span className="text-fg-3">{t("infoPanel.pullRequest")}</span>
			<span className="flex min-w-0 flex-wrap gap-x-2 gap-y-1" data-testid="task-detail-pull-requests">
				{allPullRequests(task).map((pr) => {
					const tone = prStateTone(prDisplayState(pr.state));
					return (
						<a
							key={pr.number}
							href={pr.url}
							target="_blank"
							rel="noreferrer"
							className={`inline-flex items-baseline gap-1 font-mono hover:underline ${tone.labelKey ? tone.text : "text-accent hover:text-accent-emphasis"}`}
							title={pr.title ?? undefined}
						>
							{t("task.prNumber", { number: String(pr.number) })}
							{tone.labelKey && <span className="font-sans text-dense text-fg-3">{t(tone.labelKey)}</span>}
						</a>
					);
				})}
			</span>
		</>
	);
}

function CreatedRow({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<>
			<span className="text-fg-3">{t("infoPanel.created")}</span>
			<span className="text-fg-3">{formatDate(task.createdAt)}</span>
		</>
	);
}

function OriginRow({ task, navigate }: TaskDetailItemProps) {
	return (
		<TaskOriginRow
			task={task}
			testId="task-detail-origin"
			navigate={navigate}
		/>
	);
}

function EpicRow({ task }: TaskDetailItemProps) {
	return <TaskEpicRow task={task} testId="task-detail-epic" />;
}

function UpdatedRow({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<>
			<span className="text-fg-3">{t("infoPanel.updated")}</span>
			<span className="text-fg-3">{formatDate(task.updatedAt)}</span>
		</>
	);
}

function MovedRow({ task }: TaskDetailItemProps) {
	const t = useT();
	return (
		<>
			<span className="text-fg-3">{t("infoPanel.movedAt")}</span>
			<span className="text-fg-3">{formatDate(task.movedAt!)}</span>
		</>
	);
}

/** The finished task's view, in display order: the deliverable leads, the commentary follows (bible §5). */
export const BUILTIN_TASK_DETAIL_SECTIONS: readonly TaskDetailSectionItem[] = [
	{ id: "builtin:detail.shared-outputs", region: "main", component: SharedOutputs },
	{ id: "builtin:detail.description", region: "main", when: ({ task }) => !!task.description && task.description !== getTaskTitle(task), component: Description },
	{ id: "builtin:detail.notes", region: "main", component: Notes },
	{ id: "builtin:detail.seq", region: "meta", cells: SeqRow },
	{ id: "builtin:detail.branch", region: "meta", when: ({ task }) => !!task.branchName, cells: BranchRow },
	{ id: "builtin:detail.base-branch", region: "meta", when: ({ task }) => !!task.baseBranch, cells: BaseBranchRow },
	{ id: "builtin:detail.pull-requests", region: "meta", when: ({ task }) => allPullRequests(task).length > 0, cells: PullRequestsRow },
	{ id: "builtin:detail.created", region: "meta", cells: CreatedRow },
	{ id: "builtin:detail.origin", region: "meta", cells: OriginRow },
	{ id: "builtin:detail.epic", region: "meta", cells: EpicRow },
	{ id: "builtin:detail.updated", region: "meta", cells: UpdatedRow },
	{ id: "builtin:detail.moved", region: "meta", when: ({ task }) => !!task.movedAt, cells: MovedRow },
];

export function installTaskDetailSectionBuiltins(ctx: Context): Fiber {
	return ctx.plugin({
		name: TASK_DETAIL_SECTIONS_BUILTIN_ID,
		inject: ["taskDetailSections"],
		apply(pluginCtx: Context) {
			for (const def of BUILTIN_TASK_DETAIL_SECTIONS) pluginCtx.taskDetailSections.register(def);
		},
	});
}

/** Required: the finished task's view has no other body. */
export const BUILTIN_TASK_DETAIL_SECTIONS_PLUGIN: BuiltinPlugin = {
	id: TASK_DETAIL_SECTIONS_BUILTIN_ID,
	required: true,
	install: installTaskDetailSectionBuiltins,
};
