import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { getProject } from "./data";
import { projectSlug } from "./git";
import { DEV3_HOME } from "./paths";
import { isSafeBoardId, normalizeBoardViewState, type BoardRef, type BoardViewState } from "../shared/board-view-state";

// Both are NEW files (AGENTS.md on-disk rules 2 and 5): older app versions never
// read them, nothing is renamed, and nothing is written until the user changes a view.
const BOARD_VIEWS_FILE = "board-views.json";
const SPACE_BOARD_VIEWS_DIR = `${DEV3_HOME}/space-board-views`;

export async function boardViewStatePath(board: BoardRef): Promise<string> {
	if (board.kind === "space") {
		if (!isSafeBoardId(board.id)) throw new Error(`Invalid space id: ${board.id}`);
		return `${SPACE_BOARD_VIEWS_DIR}/${board.id}.json`;
	}
	const project = await getProject(board.id);
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/${BOARD_VIEWS_FILE}`;
}

async function readState(filePath: string): Promise<BoardViewState> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return normalizeBoardViewState(null);
		throw err;
	}
	try {
		return normalizeBoardViewState(JSON.parse(raw));
	} catch {
		// A torn or hand-edited file must not cost the user their board.
		return normalizeBoardViewState(null);
	}
}

export async function loadBoardViewState(board: BoardRef): Promise<BoardViewState> {
	return readState(await boardViewStatePath(board));
}

export async function saveBoardViewState(board: BoardRef, state: BoardViewState): Promise<BoardViewState> {
	const filePath = await boardViewStatePath(board);
	const normalized = normalizeBoardViewState(state);
	await withFileLock(filePath, async () => {
		await mkdir(dirname(filePath), { recursive: true });
		await atomicWriteFile(filePath, JSON.stringify(normalized, null, 2));
	});
	return normalized;
}
