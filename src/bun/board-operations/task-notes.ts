import type { NoteSource, Project, TaskNote } from "../../shared/types";
import { appendTaskNote } from "../../shared/types";
import * as data from "../data";
import { noteSourceOf, pushTaskUpdated, type BoardActor, type BoardPorts, type TaskOpResult } from "./types";

/**
 * Task notes, one implementation for every door. Each write recomputes the notes
 * array from the task read inside the tasks-file lock, so two concurrent writers
 * (routine for multi-variant bug hunters) cannot drop each other's note.
 */

export async function addNote(
	ports: BoardPorts,
	project: Project,
	taskId: string,
	content: string,
	actor: BoardActor,
	source: NoteSource = noteSourceOf(actor),
): Promise<TaskOpResult & { note: TaskNote }> {
	if (!content) throw new Error("content is required");
	const { task, result: note } = await data.updateTaskWith(project, taskId, (current) => {
		const now = new Date().toISOString();
		const note: TaskNote = { id: crypto.randomUUID(), content, source, createdAt: now, updatedAt: now };
		return { updates: { notes: appendTaskNote(current.notes, note) }, result: note };
	});
	pushTaskUpdated(ports, project, task);
	return { verdict: "applied", task, rejected: [], note };
}

/** A missing note or unchanged content is a no-op: no write, no push. */
export async function updateNote(
	ports: BoardPorts,
	project: Project,
	taskId: string,
	noteId: string,
	content: string,
): Promise<TaskOpResult> {
	const { task, result: changed } = await data.updateTaskWith(project, taskId, (current) => {
		const notes = current.notes ?? [];
		const target = notes.find((note) => note.id === noteId);
		if (!target || target.content === content) return { updates: {}, result: false };
		const updatedAt = new Date().toISOString();
		return {
			updates: { notes: notes.map((note) => (note.id === noteId ? { ...note, content, updatedAt } : note)) },
			result: true,
		};
	});
	if (changed) pushTaskUpdated(ports, project, task);
	return { verdict: changed ? "applied" : "noop", task, rejected: [] };
}

/** Takes a full note id; prefix resolution belongs to the adapter. Missing → no-op. */
export async function deleteNote(
	ports: BoardPorts,
	project: Project,
	taskId: string,
	noteId: string,
): Promise<TaskOpResult> {
	const { task, result: changed } = await data.updateTaskWith(project, taskId, (current) => {
		const notes = current.notes ?? [];
		if (!notes.some((note) => note.id === noteId)) return { updates: {}, result: false };
		return { updates: { notes: notes.filter((note) => note.id !== noteId) }, result: true };
	});
	if (changed) pushTaskUpdated(ports, project, task);
	return { verdict: changed ? "applied" : "noop", task, rejected: [] };
}
