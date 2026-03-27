import type { Project, Task } from "../../shared/types";
import { STATUS_LABELS, getTaskTitle } from "../../shared/types";
import { detectContext, detectContextDiagnostics, readProjectDirect, readTaskDirect } from "../context";
import { sendRequest } from "../socket-client";
import { printDetail, exitError } from "../output";
import { BUILD_TIME, BUILD_COMMIT, BUILD_VERSION } from "../../shared/build-info.generated";

/**
 * Show current project/task context detected from worktree.
 * Works without the app running (reads data files directly).
 * If the app is running, fetches live data via socket.
 */
export async function handleCurrent(socketPath: string | null): Promise<void> {
	const context = detectContext();
	if (!context) {
		const diag = detectContextDiagnostics();
		exitError(
			"not inside a dev3 worktree",
			`Run this command from inside a dev3-managed worktree directory.\n\nDiagnostics:\n${diag}`,
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
				const displayTitle = getTaskTitle(task);

				const statusDisplay = task.customColumnId
					? `${STATUS_LABELS[task.status] || task.status} (in custom column)`
					: (STATUS_LABELS[task.status] || task.status);

				const fields: Array<[string, string]> = [
					["Project:", project?.name || context.projectId.slice(0, 8)],
					["Project ID:", context.projectId],
					["Task ID:", task.id],
					["Seq:", String(task.seq)],
					["Title:", displayTitle],
					["Status:", statusDisplay],
				];
				if (task.customColumnId) fields.push(["Custom Column:", task.customColumnId.slice(0, 8)]);
				if (task.branchName) fields.push(["Branch:", task.branchName]);
				if (task.worktreePath) fields.push(["Worktree:", task.worktreePath]);

				if (task.description && task.description !== displayTitle) {
					fields.push(["", ""]);
					fields.push(["Description:", ""]);
				}

				printDetail(fields);

				if (task.description && task.description !== displayTitle) {
					for (const line of task.description.split("\n")) {
						process.stdout.write(`  ${line}\n`);
					}
				}

				// Show custom columns for this project
				const customColumns = (project as Project | null)?.customColumns ?? [];
				if (customColumns.length > 0) {
					process.stdout.write("\n");
					process.stdout.write("Custom columns (use with `dev3 task move --status <id>`):\n");
					for (const col of customColumns) {
						const instruction = col.llmInstruction
							? `  → "${col.llmInstruction}"`
							: "";
						process.stdout.write(`  ${col.id.slice(0, 8)}   ${col.name}${instruction}\n`);
					}
				}

				process.stdout.write(`\nCLI build: v${BUILD_VERSION} (${BUILD_COMMIT}) ${BUILD_TIME}\n`);

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
		const displayTask = task as Pick<Task, "title" | "customTitle">;
		const displayTitle = getTaskTitle(displayTask as Task);

		if (task.seq !== undefined) fields.push(["Seq:", String(task.seq)]);
		if (displayTitle) fields.push(["Title:", displayTitle]);
		if (task.status) fields.push(["Status:", STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || (task.status as string)]);
		if (task.branchName) fields.push(["Branch:", task.branchName as string]);
		if (task.worktreePath) fields.push(["Worktree:", task.worktreePath as string]);

		const desc = task.description as string | undefined;
		if (desc && desc !== displayTitle) {
			fields.push(["", ""]);
			fields.push(["Description:", ""]);
		}

		fields.push(["", ""]);
		fields.push(["(offline)", "App not running — showing cached data"]);

		printDetail(fields);

		if (desc && desc !== displayTitle) {
			for (const line of desc.split("\n")) {
				process.stdout.write(`  ${line}\n`);
			}
		}
	} else {
		fields.push(["", ""]);
		fields.push(["(offline)", "App not running — showing cached data"]);

		printDetail(fields);
	}

	process.stdout.write(`\nCLI build: v${BUILD_VERSION} (${BUILD_COMMIT}) ${BUILD_TIME}\n`);
}
