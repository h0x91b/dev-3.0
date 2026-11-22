import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { getProject } from "./data";
import { projectSlug } from "./git";
import { DEV3_HOME } from "./paths";
import {
	applyNamedViewChange,
	isSafeBoardId,
	normalizeBoardViewState,
	withNamedViewsFrom,
	type BoardRef,
	type BoardViewState,
	type NamedViewChange,
} from "../shared/board-view-state";

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

async function rewriteState(board: BoardRef, change: (onDisk: BoardViewState) => BoardViewState): Promise<BoardViewState> {
	const filePath = await boardViewStatePath(board);
	return withFileLock(filePath, async () => {
		const next = normalizeBoardViewState(change(await readState(filePath)));
		await mkdir(dirname(filePath), { recursive: true });
		await atomicWriteFile(filePath, JSON.stringify(next, null, 2));
		return next;
	});
}

/**
 * Saves the working views and slots. Named views always come from the file: a
 * window holding an older copy must not drop one another window just saved.
 */
export async function saveBoardViewState(board: BoardRef, state: BoardViewState): Promise<BoardViewState> {
	const incoming = normalizeBoardViewState(state);
	return rewriteState(board, (onDisk) => withNamedViewsFrom(incoming, onDisk));
}

/** Adds, updates, renames or deletes one named view against the file as it is now. */
export async function changeNamedBoardView(board: BoardRef, change: NamedViewChange): Promise<BoardViewState> {
	return rewriteState(board, (onDisk) => applyNamedViewChange(onDisk, change));
}
