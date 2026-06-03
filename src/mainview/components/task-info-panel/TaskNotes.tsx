import type { Dispatch } from "react";
import { toast } from "../../toast";
import { NoteItem } from "../NoteItem";
import type { Project, Task } from "../../../shared/types";
import type { AppAction } from "../../state";
import { api } from "../../rpc";
import { useT } from "../../i18n";

interface TaskNotesProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
}

export default function TaskNotes({ task, project, dispatch }: TaskNotesProps) {
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
			toast.error(t("notes.failedAdd", { error: String(err) }));
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
			toast.error(t("notes.failedDelete", { error: String(err) }));
		}
	}

	return (
		<div className="mt-3 border-t border-edge pt-3">
			<div className="flex items-center justify-between mb-2">
				<span className="text-xs text-fg-3 font-semibold uppercase tracking-wider">
					{t("notes.title")}
				</span>
				<button
					onClick={handleAddNote}
					className="text-xs text-accent hover:text-accent-hover transition-colors"
				>
					{t("notes.add")}
				</button>
			</div>
			{(task.notes ?? []).length === 0 && (
				<span className="text-xs text-fg-muted">{t("notes.empty")}</span>
			)}
			{(task.notes ?? []).map((note) => (
				<NoteItem
					key={note.id}
					note={note}
					onSave={(content) => handleUpdateNote(note.id, content)}
					onDelete={() => handleDeleteNote(note.id)}
					projectId={project.id}
				/>
			))}
		</div>
	);
}
