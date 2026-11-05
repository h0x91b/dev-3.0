/**
 * Writes and restores the board copy in `<project>/.dev3/board/` (layout and
 * field allowlist: `src/shared/board-copy.ts`). Opt-in per project through
 * `Project.boardCopy`. The copy is written a few seconds after a board change,
 * only the files whose bytes changed, and a failure never reaches the board:
 * it is logged, retried, and shown as one warning per failure streak.
 * Measurements and trade-offs: `decisions/2026/10/28/board-copy-in-the-project-folder.md`.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	BOARD_COPY_DIR,
	BOARD_COPY_GITIGNORE,
	BOARD_COPY_MANIFEST,
	BOARD_COPY_MESSAGES_DIR,
	BOARD_COPY_NOTES_DIR,
	BOARD_COPY_README,
	BOARD_COPY_TASKS_DIR,
	boardCopyNotesFileName,
	boardCopyTaskFileName,
	buildBoardCopyManifest,
	parseBoardCopyManifest,
	parseBoardCopyTask,
	renderTaskMessagesMarkdown,
	renderTaskNotesMarkdown,
	restoreTasksFromCopy,
	toBoardCopyTask,
	type BoardCopyTask,
} from "../shared/board-copy";
import type { AgentMessageLogRow } from "../shared/agent-message-log";
import type { BoardCopyFailureReason, BoardCopyOffer, Project, Task } from "../shared/types";
import { readAgentMessageLog } from "./agent-message-log";
import { atomicWriteFile } from "./atomic-write";
import * as data from "./data";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("board-copy");

/** Trailing quiet period before a write. A burst of board changes becomes one write. */
export const BOARD_COPY_DEBOUNCE_MS = 3_000;
/** A board that never goes quiet (agents updating tasks every second) is still written this often. */
export const BOARD_COPY_MAX_WAIT_MS = 30_000;
/** A failed write is tried again after this long even if the board does not change. */
export const BOARD_COPY_RETRY_MS = 30_000;
/** Message rows read per export when the messages option is on. The log itself keeps 30 days. */
const MESSAGE_ROWS_LIMIT = 5_000;

export function boardCopyEnabled(project: Pick<Project, "boardCopy" | "kind" | "deleted">): boolean {
	return project.boardCopy === true && project.kind !== "virtual" && !project.deleted;
}

export function boardCopyDir(projectPath: string): string {
	return join(projectPath, BOARD_COPY_DIR);
}

export interface BoardCopyExportResult {
	dir: string;
	taskCount: number;
	written: number;
	removed: number;
}

export class BoardCopyError extends Error {
	constructor(public readonly reason: BoardCopyFailureReason, message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

export function classifyBoardCopyError(err: unknown): BoardCopyFailureReason {
	if (err instanceof BoardCopyError) return err.reason;
	const code = (err as { code?: string } | null)?.code;
	if (code === "EROFS" || code === "EACCES" || code === "EPERM" || code === "EBUSY") return "not-writable";
	if (code === "ENOSPC" || code === "EDQUOT") return "disk-full";
	return "other";
}

interface ProjectCopyState {
	timer: ReturnType<typeof setTimeout> | null;
	firstPendingAt: number | null;
	running: Promise<void> | null;
	rerun: boolean;
	/** Bytes this process last wrote per relative path. Null until a write has compared against the disk. */
	written: Map<string, string> | null;
	failing: boolean;
}

const states = new Map<string, ProjectCopyState>();
let unsubscribe: (() => void) | null = null;

function stateFor(projectId: string): ProjectCopyState {
	let state = states.get(projectId);
	if (!state) {
		state = { timer: null, firstPendingAt: null, running: null, rerun: false, written: null, failing: false };
		states.set(projectId, state);
	}
	return state;
}

async function readIfExists(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

function messagesByTask(project: Project): Map<string, AgentMessageLogRow[]> {
	const byTask = new Map<string, AgentMessageLogRow[]>();
	for (const row of [...readAgentMessageLog(project, MESSAGE_ROWS_LIMIT).rows].reverse()) {
		const list = byTask.get(row.toTaskId) ?? [];
		list.push(row);
		byTask.set(row.toTaskId, list);
	}
	return byTask;
}

/** Everything the copy should hold except `board.json`, keyed by path relative to the copy folder. */
function desiredFiles(project: Project, tasks: Task[]): { files: Map<string, string>; taskFiles: string[] } {
	const files = new Map<string, string>([
		["README.md", BOARD_COPY_README],
		[".gitignore", BOARD_COPY_GITIGNORE],
	]);
	const taskFiles: string[] = [];
	const messages = project.boardCopyMessages ? messagesByTask(project) : null;
	for (const task of tasks) {
		const name = boardCopyTaskFileName(task);
		taskFiles.push(name);
		files.set(`${BOARD_COPY_TASKS_DIR}/${name}`, `${JSON.stringify(toBoardCopyTask(task), null, 2)}\n`);
		if (task.notes?.length) files.set(`${BOARD_COPY_NOTES_DIR}/${boardCopyNotesFileName(task)}`, renderTaskNotesMarkdown(task));
		const rows = messages?.get(task.id);
		if (rows?.length) files.set(`${BOARD_COPY_MESSAGES_DIR}/${boardCopyNotesFileName(task)}`, renderTaskMessagesMarkdown(task, rows));
	}
	return { files, taskFiles };
}

/**
 * Two copies are never replaced: one from a newer format, and a copy with tasks
 * when the board is empty and this process has not written the copy yet - the
 * shape of a wiped dev3 data folder, where the copy is the only board left. An
 * empty board this process has been copying all along is an ordinary deletion.
 */
function assertSafeToReplace(previousManifest: string, taskCount: number, firstWrite: boolean): void {
	const parsed = parseBoardCopyManifest(previousManifest);
	if (!parsed.ok && parsed.reason === "unsupported-version") {
		throw new BoardCopyError("unsupported-copy", `Board copy format ${String(parsed.version)} is newer than this dev3 writes`);
	}
	if (parsed.ok && taskCount === 0 && firstWrite && parsed.manifest.taskCount > 0) {
		throw new BoardCopyError("kept-copy", `Board is empty but its copy holds ${parsed.manifest.taskCount} task(s); the copy is kept`);
	}
}

function manifestWithoutTime(content: string): string {
	return content.replace(/"exportedAt": "[^"]*"/, "");
}

/**
 * Bring the copy in line with the board now. Writes only files whose bytes
 * differ, removes files of tasks that left the board, and writes `board.json`
 * last so its file list never names a task file that is not there yet. Never
 * creates the project folder itself. Throws a {@link BoardCopyError} or a raw
 * fs error; callers that must not fail use {@link runBoardCopy}.
 */
export async function exportBoardCopy(project: Project, options: { compareWithDisk?: boolean; now?: Date } = {}): Promise<BoardCopyExportResult> {
	if (!existsSync(project.path)) {
		throw new BoardCopyError("missing-folder", `Project folder not found: ${project.path}`);
	}
	const dir = boardCopyDir(project.path);
	const state = stateFor(project.id);
	const firstWrite = !state.written;
	const known = options.compareWithDisk || firstWrite ? null : state.written;
	const tasks = await data.loadTasks(project);
	const previousManifest = known ? known.get(BOARD_COPY_MANIFEST) ?? null : await readIfExists(join(dir, BOARD_COPY_MANIFEST));
	if (previousManifest !== null) assertSafeToReplace(previousManifest, tasks.length, firstWrite);
	const { files, taskFiles } = desiredFiles(project, tasks);

	for (const sub of [BOARD_COPY_TASKS_DIR, BOARD_COPY_NOTES_DIR, BOARD_COPY_MESSAGES_DIR]) {
		await mkdir(join(dir, sub), { recursive: true });
	}
	const written = new Map<string, string>();
	let writes = 0;
	for (const [rel, content] of files) {
		const previous = known ? known.get(rel) ?? null : await readIfExists(join(dir, rel));
		if (previous !== content) {
			await atomicWriteFile(join(dir, rel), content);
			writes++;
		}
		written.set(rel, content);
	}

	let removed = 0;
	for (const sub of [BOARD_COPY_TASKS_DIR, BOARD_COPY_NOTES_DIR, BOARD_COPY_MESSAGES_DIR]) {
		for (const entry of await readdir(join(dir, sub))) {
			if (files.has(`${sub}/${entry}`)) continue;
			await unlink(join(dir, sub, entry)).catch((err) => {
				if (err?.code !== "ENOENT") throw err;
			});
			removed++;
		}
	}

	const manifest = `${JSON.stringify(buildBoardCopyManifest(project, taskFiles, (options.now ?? new Date()).toISOString()), null, 2)}\n`;
	if (writes > 0 || removed > 0 || previousManifest === null || manifestWithoutTime(previousManifest) !== manifestWithoutTime(manifest)) {
		await atomicWriteFile(join(dir, BOARD_COPY_MANIFEST), manifest);
		written.set(BOARD_COPY_MANIFEST, manifest);
		writes++;
	} else {
		written.set(BOARD_COPY_MANIFEST, previousManifest);
	}
	state.written = written;
	return { dir, taskCount: tasks.length, written: writes, removed };
}

function reportFailure(project: Project, err: unknown): void {
	const state = stateFor(project.id);
	const reason = classifyBoardCopyError(err);
	log.warn("Board copy write failed", { projectId: project.id, reason, error: String(err) });
	// The cache may describe files that never landed; compare with the disk next time.
	state.written = null;
	if (!state.failing) {
		state.failing = true;
		getPushMessage()?.("boardCopyFailed", { projectId: project.id, projectName: project.name, reason });
	}
	if (!state.timer) {
		state.timer = setTimeout(() => {
			state.timer = null;
			void runBoardCopy(project.id);
		}, BOARD_COPY_RETRY_MS);
	}
}

/** Export one project if its copy is on. Never throws; overlapping calls fold into one follow-up run. */
export async function runBoardCopy(projectId: string): Promise<void> {
	const state = stateFor(projectId);
	if (state.running) {
		state.rerun = true;
		return state.running;
	}
	state.running = (async () => {
		do {
			state.rerun = false;
			let project: Project;
			try {
				project = await data.getProject(projectId);
			} catch {
				states.delete(projectId);
				return;
			}
			if (!boardCopyEnabled(project)) {
				state.failing = false;
				state.written = null;
				return;
			}
			try {
				await exportBoardCopy(project);
				if (state.failing) log.info("Board copy writes again", { projectId });
				state.failing = false;
			} catch (err) {
				reportFailure(project, err);
			}
		} while (state.rerun);
	})().finally(() => {
		state.running = null;
	});
	return state.running;
}

/** Debounced: {@link BOARD_COPY_DEBOUNCE_MS} after the last change, at most {@link BOARD_COPY_MAX_WAIT_MS} after the first. */
export function scheduleBoardCopy(projectId: string, now: number = Date.now()): void {
	const state = stateFor(projectId);
	if (state.timer) clearTimeout(state.timer);
	state.firstPendingAt ??= now;
	const delay = Math.max(0, Math.min(BOARD_COPY_DEBOUNCE_MS, state.firstPendingAt + BOARD_COPY_MAX_WAIT_MS - now));
	state.timer = setTimeout(() => {
		state.timer = null;
		state.firstPendingAt = null;
		void runBoardCopy(projectId);
	}, delay);
}

async function scheduleEnabledProjects(): Promise<void> {
	for (const project of await data.loadProjects()) {
		if (boardCopyEnabled(project)) scheduleBoardCopy(project.id);
	}
}

/**
 * Start following board changes. Also schedules one pass for every enabled
 * project, so a change made just before the last quit still reaches the copy.
 */
export function startBoardCopy(): void {
	if (unsubscribe) return;
	unsubscribe = data.onBoardChanged((projectId) => {
		if (projectId) {
			void scheduleIfEnabled(projectId);
			return;
		}
		void scheduleEnabledProjects().catch((err) => log.warn("Board copy scan failed", { error: String(err) }));
	});
	void scheduleEnabledProjects().catch((err) => log.warn("Board copy startup scan failed", { error: String(err) }));
}

async function scheduleIfEnabled(projectId: string): Promise<void> {
	try {
		const project = await data.getProject(projectId);
		if (boardCopyEnabled(project)) scheduleBoardCopy(projectId);
	} catch {
		// Virtual boards and deleted projects have no copy.
	}
}

export function stopBoardCopy(): void {
	unsubscribe?.();
	unsubscribe = null;
	for (const state of states.values()) if (state.timer) clearTimeout(state.timer);
	states.clear();
}

// ---- Restore ----

/** What the folder's copy holds, for the restore offer. Null when there is no copy at all. */
export async function readBoardCopyOffer(projectPath: string): Promise<BoardCopyOffer | null> {
	const raw = await readIfExists(join(boardCopyDir(projectPath), BOARD_COPY_MANIFEST));
	if (raw === null) return null;
	const parsed = parseBoardCopyManifest(raw);
	if (!parsed.ok) {
		return parsed.reason === "unsupported-version"
			? { status: "unsupported-version", version: String(parsed.version) }
			: { status: "invalid" };
	}
	return { status: "ok", taskCount: parsed.manifest.taskCount, exportedAt: parsed.manifest.exportedAt };
}

/** The offer to show after an add: only for a project whose dev3 board is still empty. */
export async function boardCopyOfferForNewProject(project: Project): Promise<BoardCopyOffer | null> {
	if (project.kind === "virtual") return null;
	const offer = await readBoardCopyOffer(project.path).catch(() => null);
	if (!offer) return null;
	// A copy of an empty board has nothing to restore.
	if (offer.status === "ok" && offer.taskCount === 0) return null;
	const tasks = await data.loadTasks(project);
	return tasks.length === 0 ? offer : null;
}

export type BoardCopyRestoreResult =
	| { ok: true; restored: number; missing: number }
	| { ok: false; reason: "no-copy" | "invalid" | "unsupported-version" | "board-not-empty"; version?: string };

/**
 * Restore an empty board from its folder copy. Refuses a board that already has
 * tasks, so a restore can never overwrite anything. Labels and custom columns
 * from the copy join the project's own (the project's win on an id clash).
 * Turns the copy on, so the restored board keeps being copied.
 */
export async function restoreBoardCopy(projectId: string, options: { now?: Date } = {}): Promise<BoardCopyRestoreResult> {
	const project = await data.getProject(projectId);
	const dir = boardCopyDir(project.path);
	const raw = await readIfExists(join(dir, BOARD_COPY_MANIFEST));
	if (raw === null) return { ok: false, reason: "no-copy" };
	const parsed = parseBoardCopyManifest(raw);
	if (!parsed.ok) {
		return parsed.reason === "unsupported-version"
			? { ok: false, reason: "unsupported-version", version: String(parsed.version) }
			: { ok: false, reason: "invalid" };
	}
	const { manifest } = parsed;

	const copies: BoardCopyTask[] = [];
	let missing = 0;
	for (const name of manifest.taskFiles) {
		const content = await readIfExists(join(dir, BOARD_COPY_TASKS_DIR, name));
		if (content === null) {
			missing++;
			continue;
		}
		let task: BoardCopyTask | null = null;
		try {
			task = parseBoardCopyTask(JSON.parse(content));
		} catch {
			// Unparseable JSON counts as missing, like a task that is not one.
		}
		if (task) copies.push(task);
		else missing++;
	}

	const takenIds = new Set<string>();
	for (const other of [...await data.loadProjects(), ...await data.loadVirtualProjects()]) {
		if (other.id === project.id) continue;
		for (const task of await data.loadTasks(other).catch(() => [] as Task[])) takenIds.add(task.id);
	}
	const restored = restoreTasksFromCopy(copies, project.id, {
		now: (options.now ?? new Date()).toISOString(),
		takenIds,
		newId: () => crypto.randomUUID(),
	});

	const accepted = await data.restoreTasksIntoEmptyBoard(project, restored);
	if (!accepted) return { ok: false, reason: "board-not-empty" };

	await data.updateProjectWith(project.id, (current) => {
		const labelIds = new Set((current.labels ?? []).map((label) => label.id));
		const columnIds = new Set((current.customColumns ?? []).map((column) => column.id));
		return {
			updates: {
				labels: [...(current.labels ?? []), ...manifest.labels.filter((label) => !labelIds.has(label.id))],
				customColumns: [...(current.customColumns ?? []), ...manifest.customColumns.filter((column) => !columnIds.has(column.id))],
				...(current.columnOrder || !manifest.columnOrder ? {} : { columnOrder: manifest.columnOrder }),
				...(current.customStatusLabels || !manifest.customStatusLabels ? {} : { customStatusLabels: manifest.customStatusLabels }),
				boardCopy: true,
			},
			result: undefined,
		};
	});
	log.info("Board restored from the project copy", { projectId, restored: restored.length, missing });
	return { ok: true, restored: restored.length, missing };
}
