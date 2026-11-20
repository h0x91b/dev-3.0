import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "../rpc";
import {
	activeSavedView,
	defaultBoardViewState,
	withLayout,
	withViewType,
	type BoardFormFactor,
	type BoardRef,
	type BoardViewState,
} from "../../shared/board-view-state";

export interface BoardViewStateHandle {
	viewType: string;
	layout: (viewId: string) => unknown;
	setLayout: (viewId: string, layout: unknown) => void;
	setViewType: (viewType: string) => void;
}

// Survives remounts within a session, so returning to a board shows its view at
// once instead of flashing the default while the file is read again.
const cache = new Map<string, BoardViewState>();
const DEFAULT_STATE = defaultBoardViewState();
// One read per board at a time, shared by the prefetch and the hook.
const reads = new Map<string, Promise<void>>();
// Boards whose read has landed, failed or timed out: the board may render.
const settled = new Set<string>();
// Bumped on every user change: a read that started before one must not overwrite it.
const editCounts = new Map<string, number>();
// Saves not yet acknowledged: the host reads without its lock, so a read started now may return the old file.
const savesInFlight = new Map<string, number>();
const listeners = new Set<() => void>();

/** Lets a silent (lost) request stop holding the board hidden; the transport itself waits 6 minutes. */
export const VIEW_STATE_READ_TIMEOUT_MS = 3_000;

function boardKey(board: BoardRef): string {
	return `${board.kind}:${board.id}`;
}

export function resetBoardViewStateCacheForTests(): void {
	cache.clear();
	reads.clear();
	settled.clear();
	editCounts.clear();
	savesInFlight.clear();
}

function notify(): void {
	for (const listener of listeners) listener();
}

function markSettled(key: string): void {
	settled.add(key);
	notify();
}

function isReady(key: string): boolean {
	return cache.has(key) || settled.has(key);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

// One read per board at a time. On a cache hit it is a background refresh: the
// result replaces the cache only if it differs and no user change or save was in progress when it started.
function readViewState(board: BoardRef): Promise<void> {
	const key = boardKey(board);
	const inFlight = reads.get(key);
	if (inFlight) return inFlight;
	const editsAtStart = editCounts.get(key) ?? 0;
	const savingAtStart = (savesInFlight.get(key) ?? 0) > 0;
	// A timed-out read frees its slot so the next mount reads again; its late result still applies.
	const timer = isReady(key) ? null : setTimeout(() => {
		console.warn("[board-views] view state read timed out");
		if (reads.get(key) === read) reads.delete(key);
		markSettled(key);
	}, VIEW_STATE_READ_TIMEOUT_MS);
	// Deferred so a transport without this method (an older host) rejects instead of throwing.
	const read: Promise<void> = Promise.resolve()
		.then(() => api.request.getBoardViewState({ board: { kind: board.kind, id: board.id } }))
		.then((state) => {
			const unchanged = !savingAtStart && (editCounts.get(key) ?? 0) === editsAtStart;
			if (unchanged && JSON.stringify(cache.get(key)) !== JSON.stringify(state)) cache.set(key, state);
			markSettled(key);
		})
		.catch((err) => {
			console.warn("[board-views] failed to read view state:", err);
			markSettled(key);
		})
		.finally(() => {
			if (timer) clearTimeout(timer);
			if (reads.get(key) === read) reads.delete(key);
		});
	reads.set(key, read);
	return read;
}

/** Starts reading a board's saved view state so a later mount finds it settled. */
export function prefetchBoardViewState(board: BoardRef): void {
	if (!cache.has(boardKey(board))) void readViewState(board);
}

/** True once the board's saved view state has settled; also starts the read. */
export function useBoardViewStateReady(board: BoardRef): boolean {
	const key = boardKey(board);
	const ready = useSyncExternalStore(subscribe, () => isReady(key));
	const { kind, id } = board;
	useEffect(() => prefetchBoardViewState({ kind, id }), [kind, id]);
	return ready;
}

/**
 * The board's saved view selection and layouts (§4.4), read once per board and
 * written through on every change. A failed read or write keeps the in-memory
 * state: a view preference must never block the board.
 */
export function useBoardViewState(board: BoardRef, formFactor: BoardFormFactor): BoardViewStateHandle {
	const key = boardKey(board);
	const state = useSyncExternalStore(subscribe, () => cache.get(key)) ?? DEFAULT_STATE;
	const boardKind = board.kind;
	const boardId = board.id;
	useEffect(() => {
		void readViewState({ kind: boardKind, id: boardId });
	}, [boardKind, boardId]);

	const stateRef = useRef(state);
	stateRef.current = state;
	const update = useCallback((change: (state: BoardViewState) => BoardViewState) => {
		const base = stateRef.current;
		const next = change(base);
		if (next === base) return;
		stateRef.current = next;
		cache.set(key, next);
		editCounts.set(key, (editCounts.get(key) ?? 0) + 1);
		notify();
		savesInFlight.set(key, (savesInFlight.get(key) ?? 0) + 1);
		Promise.resolve()
			.then(() => api.request.setBoardViewState({ board: { kind: boardKind, id: boardId }, state: next }))
			.catch((err) => console.warn("[board-views] failed to save view state:", err))
			.finally(() => savesInFlight.set(key, (savesInFlight.get(key) ?? 1) - 1));
	}, [key, boardKind, boardId]);

	const view = activeSavedView(state, formFactor);
	const layout = useCallback((viewId: string) => view.layouts[viewId], [view]);
	const setLayout = useCallback(
		(viewId: string, value: unknown) => update((state) => withLayout(state, formFactor, viewId, value)),
		[update, formFactor],
	);
	const setViewType = useCallback(
		(viewType: string) => update((state) =>
			activeSavedView(state, formFactor).viewType === viewType ? state : withViewType(state, formFactor, viewType)),
		[update, formFactor],
	);
	return { viewType: view.viewType, layout, setLayout, setViewType };
}
