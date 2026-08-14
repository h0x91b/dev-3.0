import type { Dispatch } from "react";
import { toast } from "../../toast";
import { NoteItem } from "../NoteItem";
import HelpSpot from "../HelpSpot";
import type { Project, Task } from "../../../shared/types";
import type { AppAction } from "../../state";
import { api } from "../../rpc";
import { useT } from "../../i18n";

/** Notes kept inline before the section defers to its own surface. Covers the
 *  p90 task (5 notes) without letting the 143-note tail own the details body. */
const PREVIEW_COUNT = 3;

interface TaskNotesProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	/** `full` renders every note and drops the show-all row (used by the overlay). */
	variant?: "preview" | "full";
	/** Opens the full-log surface. Absent ⇒ no show-all row, whatever the count. */
	onShowAll?: () => void;
}

export default function TaskNotes({ task, project, dispatch, variant = "preview", onShowAll }: TaskNotesProps) {
	const t = useT();

	async function handleAddNote() {
		try {
			const updated = await api.request.addTaskNote({
				taskId: task.id,
				projectId: project.id,
				content: "",
				source: "user",
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("notes.failedAdd", { error: String(err) }), { taskId: task.id });
		}
	}

	async function handleUpdateNote(noteId: string, content: string) {
		try {
			const updated = await api.request.updateTaskNote({
				taskId: task.id,
				projectId: project.id,
				noteId,
				content,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			console.error("Failed to auto-save note:", err);
		}
	}

	async function handleDeleteNote(noteId: string) {
		try {
			const updated = await api.request.deleteTaskNote({
				taskId: task.id,
				projectId: project.id,
				noteId,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("notes.failedDelete", { error: String(err) }), { taskId: task.id });
		}
	}

	const notes = task.notes ?? [];
	const preview = variant === "preview";
	// The newest notes are the ones worth reading without a tap — a task's note
	// list is an agent-written log, not a form.
	const shown = preview ? notes.slice(-PREVIEW_COUNT) : notes;
	const hidden = notes.length - shown.length;

	return (
		<div className={preview ? "mt-3 border-t border-edge pt-3" : ""} data-testid="task-notes">
			<div className="flex items-center justify-between mb-2">
				<span className="flex items-center gap-1.5">
					{/* The overlay names itself, and counts what it holds, in its own header. */}
					{preview && (
						<>
							<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">
								{t("notes.title")}
							</span>
							{notes.length > 0 && (
								<span className="text-dense font-semibold text-accent tabular-nums" data-testid="task-notes-count">
									{notes.length}
								</span>
							)}
						</>
					)}
					<HelpSpot topicId="inspector.notes" />
				</span>
				<button
					onClick={handleAddNote}
					className="text-xs text-accent hover:text-accent-emphasis transition-colors"
				>
					{t("notes.add")}
				</button>
			</div>
			{notes.length === 0 && (
				<div className="text-xs text-fg-muted">
					<p>{t("notes.empty")}</p>
					<p className="mt-0.5">{t("notes.emptyHint")}</p>
				</div>
			)}
			{hidden > 0 && onShowAll && (
				<button
					type="button"
					onClick={onShowAll}
					className="mb-2 w-full rounded-lg border border-edge px-2 py-1.5 text-xs text-accent hover:bg-elevated hover:text-accent-emphasis transition-colors"
					data-testid="task-notes-show-all"
				>
					{t("notes.showAll", { count: String(notes.length) })}
				</button>
			)}
			{shown.map((note) => (
				<NoteItem
					key={note.id}
					note={note}
					taskId={task.id}
					onSave={(content) => handleUpdateNote(note.id, content)}
					onDelete={() => handleDeleteNote(note.id)}
					projectId={project.id}
					clamp
				/>
			))}
		</div>
	);
}
