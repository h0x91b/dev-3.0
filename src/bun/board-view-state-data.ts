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
	namedSavedViews,
	namedViewChangeTakesName,
	normalizeBoardViewState,
	normalizeNamedViews,
	withNamedViews,
	workingViewState,
	type BoardRef,
	type BoardViewState,
	type NamedViewChange,
	type NamedViewChangeResult,
	type SavedBoardView,
} from "../shared/board-view-state";

// All are NEW files (AGENTS.md on-disk rules 2 and 5): older app versions never
// read them, nothing is renamed, and nothing is written until the user changes a view.
// The presets get their own file, so an older build rewriting board-views.json cannot drop one.
const BOARD_VIEWS_FILE = "board-views.json";
const SAVED_VIEWS_FILE = "board-saved-views.json";
const SPACE_BOARD_VIEWS_DIR = `${DEV3_HOME}/space-board-views`;
const SPACE_SAVED_VIEWS_DIR = `${DEV3_HOME}/space-board-saved-views`;

async function boardFilePath(board: BoardRef, projectFile: string, spaceDir: string): Promise<string> {
	if (board.kind === "space") {
		if (!isSafeBoardId(board.id)) throw new Error(`Invalid space id: ${board.id}`);
		return `${spaceDir}/${board.id}.json`;
	}
	const project = await getProject(board.id);
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/${projectFile}`;
}

export function boardViewStatePath(board: BoardRef): Promise<string> {
	return boardFilePath(board, BOARD_VIEWS_FILE, SPACE_BOARD_VIEWS_DIR);
}

export function boardSavedViewsPath(board: BoardRef): Promise<string> {
	return boardFilePath(board, SAVED_VIEWS_FILE, SPACE_SAVED_VIEWS_DIR);
}

/** The parsed file, or `null` when it is missing, torn or hand-edited past reading. */
async function readJson(filePath: string): Promise<unknown> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		return JSON.parse(raw);
	} catch {
		// A torn or hand-edited file must not cost the user their board.
		return null;
	}
}

async function readWorking(board: BoardRef): Promise<BoardViewState> {
	return workingViewState(normalizeBoardViewState(await readJson(await boardViewStatePath(board))));
}

async function readNamed(board: BoardRef): Promise<SavedBoardView[]> {
	return normalizeNamedViews(await readJson(await boardSavedViewsPath(board)));
}

export async function loadBoardViewState(board: BoardRef): Promise<BoardViewState> {
	const [working, named] = await Promise.all([readWorking(board), readNamed(board)]);
	return withNamedViews(working, named);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await atomicWriteFile(filePath, JSON.stringify(value, null, 2));
}

/** Saves the working views and slots. Named views are not part of this file; the answer carries them from theirs. */
export async function saveBoardViewState(board: BoardRef, state: BoardViewState): Promise<BoardViewState> {
	const filePath = await boardViewStatePath(board);
	const working = workingViewState(state);
	await withFileLock(filePath, () => writeJson(filePath, working));
	return withNamedViews(working, await readNamed(board));
}

/** Adds, updates, renames or deletes one named view against the presets file as it is now. */
export async function changeNamedBoardView(board: BoardRef, change: NamedViewChange): Promise<NamedViewChangeResult> {
	const filePath = await boardSavedViewsPath(board);
	const working = await readWorking(board);
	return withFileLock(filePath, async () => {
		const named = await readNamed(board);
		// Unmerged, so a preset hidden behind a working view's id is still written back.
		const current: BoardViewState = { ...working, savedViews: [...working.savedViews, ...named] };
		// The name dialog checks its own copy; another window may have taken the name since.
		if (namedViewChangeTakesName(current, change)) return { state: withNamedViews(working, named), rejected: "name-taken" };
		const next = applyNamedViewChange(current, change);
		const nextNamed = namedSavedViews(next);
		if (next !== current) await writeJson(filePath, { version: 1, views: nextNamed });
		return { state: withNamedViews(working, nextNamed), rejected: null };
	});
}
