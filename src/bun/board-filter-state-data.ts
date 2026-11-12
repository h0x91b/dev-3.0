import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { getProject } from "./data";
import { projectSlug } from "./git";
import { DEV3_HOME } from "./paths";
import { normalizeBoardFilterState, type BoardFilterState } from "../shared/board-filter-state";
import { isSafeBoardId, type BoardRef } from "../shared/board-view-state";

// Both are NEW files (AGENTS.md on-disk rules 2 and 5): older app versions never
// read them, nothing is renamed, and nothing is written until the user changes a status filter.
const BOARD_FILTERS_FILE = "board-filters.json";
const SPACE_BOARD_FILTERS_DIR = `${DEV3_HOME}/space-board-filters`;

export async function boardFilterStatePath(board: BoardRef): Promise<string> {
	if (board.kind === "space") {
		if (!isSafeBoardId(board.id)) throw new Error(`Invalid space id: ${board.id}`);
		return `${SPACE_BOARD_FILTERS_DIR}/${board.id}.json`;
	}
	const project = await getProject(board.id);
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/${BOARD_FILTERS_FILE}`;
}

export async function loadBoardFilterState(board: BoardRef): Promise<BoardFilterState> {
	const filePath = await boardFilterStatePath(board);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return normalizeBoardFilterState(null);
		throw err;
	}
	try {
		return normalizeBoardFilterState(JSON.parse(raw));
	} catch {
		// A torn or hand-edited file must not cost the user their board.
		return normalizeBoardFilterState(null);
	}
}

export async function saveBoardFilterState(board: BoardRef, state: BoardFilterState): Promise<BoardFilterState> {
	const filePath = await boardFilterStatePath(board);
	const normalized = normalizeBoardFilterState(state);
	await withFileLock(filePath, async () => {
		await mkdir(dirname(filePath), { recursive: true });
		await atomicWriteFile(filePath, JSON.stringify(normalized, null, 2));
	});
	return normalized;
}
