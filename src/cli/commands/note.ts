import type { Task, TaskNote, NoteSource } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";

const VALID_SOURCES: NoteSource[] = ["user", "ai"];

function formatDate(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleDateString("en-GB", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function truncate(text: string, maxLen: number): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return oneLine.slice(0, maxLen - 1) + "…";
}

async function addNote(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const taskId = args.flags.task || context?.taskId;
	if (!taskId) {
		exitUsage("Usage: dev3 note add \"content\" (or run from inside a worktree)");
	}

	const content = args.positional[0] || args.flags.content;
	if (!content) {
		exitUsage("Content is required. Usage: dev3 note add \"your note text\"");
	}

	const source = (args.flags.source as NoteSource) || "ai";
	if (!VALID_SOURCES.includes(source)) {
		exitUsage(`Invalid --source: ${source}. Valid: ${VALID_SOURCES.join(", ")}`);
	}

	const params: Record<string, unknown> = { taskId, content, source };
	if (args.flags.project) params.projectId = args.flags.project;
	else if (context?.projectId) params.projectId = context.projectId;

	const resp = await sendRequest(socketPath, "note.add", params);
	if (!resp.ok) exitError(resp.error || "Failed to add note");

	const task = resp.data as Task;
	const note = task.notes![task.notes!.length - 1];
	process.stdout.write(`Added note ${note.id.slice(0, 8)} [${source}] to task ${task.id.slice(0, 8)}\n`);
}

async function listNotes(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const taskId = args.flags.task || args.positional[0] || context?.taskId;
	if (!taskId) {
		exitUsage("Usage: dev3 note list (or run from inside a worktree)");
	}

	const params: Record<string, unknown> = { taskId };
	if (args.flags.project) params.projectId = args.flags.project;
	else if (context?.projectId) params.projectId = context.projectId;

	const resp = await sendRequest(socketPath, "note.list", params);
	if (!resp.ok) exitError(resp.error || "Failed to list notes");

	const notes = resp.data as TaskNote[];
	if (notes.length === 0) {
		process.stdout.write("No notes\n");
		return;
	}

	const headers = ["ID", "SOURCE", "CREATED", "CONTENT"];
	const rows = notes.map((n) => [
		n.id.slice(0, 8),
		n.source,
		formatDate(n.createdAt),
		truncate(n.content, 60),
	]);
	printTable(headers, rows);
}

async function deleteNote(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const noteId = args.positional[0];
	if (!noteId) {
		exitUsage("Usage: dev3 note delete <note-id>");
	}

	const taskId = args.flags.task || context?.taskId;
	if (!taskId) {
		exitUsage("--task <id> is required (or run from inside a worktree)");
	}

	const params: Record<string, unknown> = { taskId, noteId };
	if (args.flags.project) params.projectId = args.flags.project;
	else if (context?.projectId) params.projectId = context.projectId;

	const resp = await sendRequest(socketPath, "note.delete", params);
	if (!resp.ok) exitError(resp.error || "Failed to delete note");

	process.stdout.write(`Deleted note ${noteId.slice(0, 8)}\n`);
}

export async function handleNote(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "add":
			return addNote(args, socketPath, context);
		case "list":
			return listNotes(args, socketPath, context);
		case "delete":
			return deleteNote(args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: note ${subcommand || "(none)"}` +
				"\nAvailable: note add, note list, note delete",
			);
	}
}
