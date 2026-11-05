/**
 * The board copy: a one-way, human-readable copy of a project's board inside the
 * project folder (`.dev3/board/`). dev3's own data store stays the only live
 * store; the copy is written from it and read back only by an explicit restore
 * into an empty board. Pure: the bun writer, the restore and the tests share it.
 * See `decisions/2026/10/28/board-copy-in-the-project-folder.md`.
 */

import type { AgentMessageLogRow } from "./agent-message-log";
import type { CustomColumn, Label, Project, Task, TaskStatus } from "./types";
import { ACTIVE_STATUSES, ALL_STATUSES, appendTaskMovement, getTaskTitle } from "./types";

/** Bumped only when an older reader could misread a newer copy. A restore refuses any other value. */
export const BOARD_COPY_FORMAT_VERSION = 1;
export const BOARD_COPY_FORMAT = "dev3-board-copy";

/** Relative to the project folder. */
export const BOARD_COPY_DIR = ".dev3/board";
export const BOARD_COPY_MANIFEST = "board.json";
export const BOARD_COPY_TASKS_DIR = "tasks";
export const BOARD_COPY_NOTES_DIR = "notes";
export const BOARD_COPY_MESSAGES_DIR = "messages";

/** `*` ignores the folder AND this file, so no repository ever sees the copy and the user's `.gitignore` is never touched. */
export const BOARD_COPY_GITIGNORE = "*\n";

export const BOARD_COPY_README = `# dev3 board copy

Copy written by dev3. Edits here are overwritten.

dev3 keeps this folder in step with the project's board when "Keep a copy of the
board in this project" is on in Project Settings. It exists so the board survives a
new machine, a reinstall or a wiped dev3 data folder: add this folder as a project
again and dev3 offers to restore the board from it.

- board.json - format version, project name, labels, custom columns, export time
- tasks/<seq>-<slug>.json - one file per task
- notes/<seq>.md - task notes as markdown
- messages/<seq>.md - messages agents received, only when that option is on

Task descriptions and notes are copied as written, so anything pasted into them is
here too. The folder ignores itself in git (see .gitignore here); dev3 never copies
environment values, accounts, tokens or agent session ids.
`;

/**
 * Task fields the copy carries. An allowlist on purpose: a field added to `Task`
 * later stays out of the copy until someone decides it belongs, so a new secret
 * or machine-local handle can never leak in by default. Left out: worktree and
 * terminal handles, accounts, agent session state, scheduled work, PR caches,
 * shared media (their files die with the worktree) and every transient flag.
 */
export const BOARD_COPY_TASK_FIELDS = [
	"id", "seq", "projectId", "title", "description", "overview", "userOverview", "customTitle",
	"titleEditedByUser", "status", "priority", "baseBranch", "branchName", "existingBranch",
	"prNumber", "prUrl", "pullRequests", "reviewedPr", "groupId", "variantIndex", "relations",
	"agentId", "configId", "createdAt", "updatedAt", "movedAt", "lifecycleStartedAt", "labelIds",
	"userLabelIds", "notes", "review", "customColumnId", "history", "movements", "movementsDropped", "watched",
	"manualCompletion", "draft", "hidden", "foreignCode", "taskType", "completedDiffStats", "origin",
	"statusDurations", "statusEnteredAt", "focusMs", "focusByHour",
] as const satisfies readonly (keyof Task)[];

export type BoardCopyTaskField = (typeof BOARD_COPY_TASK_FIELDS)[number];
export type BoardCopyTask = Pick<Task, BoardCopyTaskField>;

/** Board-level settings the copy carries. Scripts, env and accounts are not board state and stay out. */
export interface BoardCopyManifest {
	format: typeof BOARD_COPY_FORMAT;
	version: number;
	projectName: string;
	exportedAt: string;
	labels: Label[];
	customColumns: CustomColumn[];
	columnOrder?: string[];
	customStatusLabels?: Record<string, string>;
	taskCount: number;
	/** Every task file this export wrote, so a reader can tell a complete copy from a partial one. */
	taskFiles: string[];
}

export function toBoardCopyTask(task: BoardCopyTask): BoardCopyTask {
	const out: Record<string, unknown> = {};
	for (const field of BOARD_COPY_TASK_FIELDS) {
		if (task[field] !== undefined) out[field] = task[field];
	}
	return out as BoardCopyTask;
}

const RESTORABLE_STATUSES: ReadonlySet<string> = new Set(ALL_STATUSES);

/**
 * Read one task file back, or null when it is not a task. A copy is untrusted
 * input (a repository can commit one), so only allowlisted fields survive and
 * a field that could launch or route an agent never comes back.
 */
export function parseBoardCopyTask(value: unknown): BoardCopyTask | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || !raw.id) return null;
	if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 1) return null;
	if (typeof raw.title !== "string" || typeof raw.description !== "string" || typeof raw.baseBranch !== "string") return null;
	if (typeof raw.status !== "string" || !RESTORABLE_STATUSES.has(raw.status)) return null;
	if (raw.relations !== undefined && !Array.isArray(raw.relations)) return null;
	return toBoardCopyTask(raw as unknown as BoardCopyTask);
}

/** Lowercase ASCII words joined by hyphens, at most 40 characters; `task` when nothing is left. */
export function boardCopySlug(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug || "task";
}

/** Variants share a seq, so the variant index joins it: `12`, or `12-v2` for a variant. */
export function boardCopyTaskStem(task: Pick<Task, "seq" | "variantIndex">): string {
	return task.variantIndex != null ? `${task.seq}-v${task.variantIndex}` : String(task.seq);
}

export function boardCopyTaskFileName(task: Task): string {
	return `${boardCopyTaskStem(task)}-${boardCopySlug(getTaskTitle(task))}.json`;
}

export function boardCopyNotesFileName(task: Task): string {
	return `${boardCopyTaskStem(task)}.md`;
}

export function buildBoardCopyManifest(project: Project, taskFiles: string[], exportedAt: string): BoardCopyManifest {
	return {
		format: BOARD_COPY_FORMAT,
		version: BOARD_COPY_FORMAT_VERSION,
		projectName: project.name,
		exportedAt,
		labels: project.labels ?? [],
		customColumns: project.customColumns ?? [],
		...(project.columnOrder ? { columnOrder: project.columnOrder } : {}),
		...(project.customStatusLabels ? { customStatusLabels: project.customStatusLabels } : {}),
		taskCount: taskFiles.length,
		taskFiles: [...taskFiles].sort(),
	};
}

/** Notes for humans and agents reading the folder. The restore reads the task JSON, never this. */
export function renderTaskNotesMarkdown(task: Task): string {
	const lines = [`# #${boardCopyTaskStem(task)} ${getTaskTitle(task)}`, ""];
	for (const note of task.notes ?? []) {
		lines.push(`## ${note.createdAt} (${note.source})`, "", note.content.trimEnd(), "");
	}
	return lines.join("\n");
}

/** Messages one task's agent received, oldest first. */
export function renderTaskMessagesMarkdown(task: Task, rows: AgentMessageLogRow[]): string {
	const lines = [`# Messages to #${boardCopyTaskStem(task)} ${getTaskTitle(task)}`, ""];
	for (const row of rows) {
		const from = row.fromSeq != null ? `#${row.fromSeq}` : row.fromTitle || "dev3";
		const subject = row.subject ? ` - ${row.subject}` : "";
		lines.push(`## ${row.at} from ${from}${subject}`, "", row.body.trimEnd(), "");
	}
	return lines.join("\n");
}

export type BoardCopyManifestParse =
	| { ok: true; manifest: BoardCopyManifest }
	| { ok: false; reason: "invalid" }
	| { ok: false; reason: "unsupported-version"; version: unknown };

export function parseBoardCopyManifest(raw: string): BoardCopyManifestParse {
	let value: any;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (!value || typeof value !== "object" || value.format !== BOARD_COPY_FORMAT) return { ok: false, reason: "invalid" };
	if (value.version !== BOARD_COPY_FORMAT_VERSION) return { ok: false, reason: "unsupported-version", version: value.version };
	if (!Array.isArray(value.taskFiles) || !Array.isArray(value.labels) || !Array.isArray(value.customColumns)) {
		return { ok: false, reason: "invalid" };
	}
	return { ok: true, manifest: value as BoardCopyManifest };
}

const RESTORED_ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(ACTIVE_STATUSES);

/**
 * Turn copied tasks back into board tasks for `projectId`. A worktree is never
 * restored, so a task that was running comes back in To Do with its branch
 * cleared and the move recorded; finished and To Do tasks keep their column.
 * Ids are kept unless one is already taken on another board (a renamed project
 * folder whose old board is still registered); then every id is remapped
 * consistently, relations included, so the two boards never share an id.
 */
export function restoreTasksFromCopy(
	copies: BoardCopyTask[],
	projectId: string,
	options: { now: string; takenIds: ReadonlySet<string>; newId: () => string },
): Task[] {
	const collides = copies.some((copy) => options.takenIds.has(copy.id));
	const idMap = new Map(copies.map((copy) => [copy.id, collides ? options.newId() : copy.id]));
	return copies.map((copy) => {
		const task: Task = {
			...toBoardCopyTask(copy),
			id: idMap.get(copy.id)!,
			projectId,
			worktreePath: null,
			relations: (copy.relations ?? []).map((relation) => ({ ...relation, taskId: idMap.get(relation.taskId) ?? relation.taskId })),
		};
		if (!RESTORED_ACTIVE_STATUSES.has(copy.status)) return task;
		const moved = appendTaskMovement(copy.movements, {
			id: options.newId(),
			at: options.now,
			kind: "status",
			from: copy.status,
			to: "todo",
			fromColumnId: copy.customColumnId ?? null,
			toColumnId: null,
		});
		return {
			...task,
			status: "todo",
			branchName: null,
			customColumnId: null,
			movedAt: options.now,
			statusEnteredAt: options.now,
			movements: moved.movements,
			movementsDropped: (copy.movementsDropped ?? 0) + moved.dropped,
		};
	});
}
