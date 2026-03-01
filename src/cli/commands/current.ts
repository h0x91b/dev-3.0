import type { Task } from "../../shared/types";
import { STATUS_LABELS } from "../../shared/types";
import { detectContext, readProjectDirect, readTaskDirect } from "../context";
import { sendRequest } from "../socket-client";
import { printDetail, exitError } from "../output";

/**
 * Show current project/task context detected from worktree.
 * Works without the app running (reads data files directly).
 * If the app is running, fetches live data via socket.
 */
export async function handleCurrent(socketPath: string | null): Promise<void> {
	const context = detectContext();
	if (!context) {
		exitError(
			"not inside a dev3 worktree",
			"Run this command from inside a dev3-managed worktree directory.",
		);
	}

	// Try live data first (via socket), fall back to direct file read
	if (socketPath) {
		try {
			const resp = await sendRequest(socketPath, "task.show", {
				taskId: context.taskId,
				projectId: context.projectId,
			});

			if (resp.ok) {
				const task = resp.data as Task;
				const project = readProjectDirect(context.projectId);

				const fields: Array<[string, string]> = [
					["Project:", project?.name || context.projectId.slice(0, 8)],
					["Project ID:", context.projectId],
					["Task ID:", task.id],
					["Seq:", String(task.seq)],
					["Title:", task.title],
					["Status:", STATUS_LABELS[task.status] || task.status],
				];
				if (task.branchName) fields.push(["Branch:", task.branchName]);
				if (task.worktreePath) fields.push(["Worktree:", task.worktreePath]);

				printDetail(fields);
				return;
			}
		} catch {
			// Socket failed, fall back to direct read
		}
	}

	// Offline mode: read directly from data files
	const project = readProjectDirect(context.projectId);
	const task = readTaskDirect(context.projectId, context.taskId);

	const fields: Array<[string, string]> = [
		["Project:", project?.name || context.projectId.slice(0, 8)],
		["Project ID:", context.projectId],
		["Task ID:", context.taskId],
	];

	if (task) {
		if (task.seq !== undefined) fields.push(["Seq:", String(task.seq)]);
		if (task.title) fields.push(["Title:", task.title as string]);
		if (task.status) fields.push(["Status:", STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || (task.status as string)]);
		if (task.branchName) fields.push(["Branch:", task.branchName as string]);
	}

	fields.push(["", ""]);
	fields.push(["(offline)", "App not running — showing cached data"]);

	printDetail(fields);
}
