import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api } from "../rpc";
import {
	activeSavedView,
	defaultBoardViewState,
	namedSavedViews,
	namedViewModified,
	applyNamedViewChange,
	namedViewAddChange,
	namedViewUpdateChange,
	withLayout,
	withNamedViewApplied,
	withViewType,
	type BoardFormFactor,
	type BoardRef,
	type BoardViewState,
	type NamedViewChange,
	type SavedBoardView,
} from "../../shared/board-view-state";

export interface BoardViewStateHandle {
	viewType: string;
	layout: (viewId: string) => unknown;
	setLayout: (viewId: string, layout: unknown) => void;
	setViewType: (viewType: string) => void;
	/** Named presets of this board, shared by both form factors. */
	namedViews: readonly SavedBoardView[];
	/** The named view last applied in this form factor this session, if it still exists. */
	appliedNamedId: string | null;
	/** True when the board no longer shows what the applied named view holds. */
	appliedNamedModified: (query: string) => boolean;
	saveNamed: (name: string, query: string) => void;
	/** Loads the view type and layouts and returns the query the caller must set. */
	applyNamed: (id: string) => string | null;
	updateNamed: (id: string, query: string) => void;
	renameNamed: (id: string, name: string) => void;
	deleteNamed: (id: string) => void;
	/** Leaves the applied named view; the board keeps what it shows. */
	clearApplied: () => void;
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
// Counts reads per board: a result lands only if no newer read has started since.
const readGenerations = new Map<string, number>();
const listeners = new Set<() => void>();
// Which named view each board × form factor last applied. Session memory, like the
// board query it travels with, so a fresh launch never claims a filter it does not show.
const appliedNamed = new Map<string, string>();

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
	readGenerations.clear();
	appliedNamed.clear();
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
// result replaces the cache only if it differs, no user change or save was in progress when it
// started, and no newer read has started since.
function readViewState(board: BoardRef): Promise<void> {
	const key = boardKey(board);
	const inFlight = reads.get(key);
	if (inFlight) return inFlight;
	const editsAtStart = editCounts.get(key) ?? 0;
	const savingAtStart = (savesInFlight.get(key) ?? 0) > 0;
	const generation = (readGenerations.get(key) ?? 0) + 1;
	readGenerations.set(key, generation);
	// A slow read frees its slot so the next mount reads again; the board renders once it settles.
	const timer = setTimeout(() => {
		if (reads.get(key) === read) reads.delete(key);
		if (isReady(key)) return;
		console.warn("[board-views] view state read timed out");
		markSettled(key);
	}, VIEW_STATE_READ_TIMEOUT_MS);
	// Deferred so a transport without this method (an older host) rejects instead of throwing.
	const read: Promise<void> = Promise.resolve()
		.then(() => api.request.getBoardViewState({ board: { kind: board.kind, id: board.id } }))
		.then((state) => {
			const unchanged = !savingAtStart && (editCounts.get(key) ?? 0) === editsAtStart && readGenerations.get(key) === generation;
			if (unchanged && JSON.stringify(cache.get(key)) !== JSON.stringify(state)) cache.set(key, state);
			markSettled(key);
		})
		.catch((err) => {
			console.warn("[board-views] failed to read view state:", err);
			markSettled(key);
		})
		.finally(() => {
			clearTimeout(timer);
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
export function useBoardViewState(
	board: BoardRef,
	formFactor: BoardFormFactor,
	options?: { onNamedChangeFailed?: () => void },
): BoardViewStateHandle {
	const key = boardKey(board);
	const state = useSyncExternalStore(subscribe, () => cache.get(key)) ?? DEFAULT_STATE;
	const boardKind = board.kind;
	const boardId = board.id;
	useEffect(() => {
		void readViewState({ kind: boardKind, id: boardId });
	}, [boardKind, boardId]);

	const stateRef = useRef(state);
	stateRef.current = state;
	// Applies `next` at once, then sends it. The host's answer replaces the cache only
	// if nothing changed meanwhile: it carries named views other windows saved.
	const onNamedFailedRef = useRef(options?.onNamedChangeFailed);
	onNamedFailedRef.current = options?.onNamedChangeFailed;
	const commit = useCallback((next: BoardViewState, send: () => Promise<BoardViewState>, named = false) => {
		let failed = false;
		stateRef.current = next;
		cache.set(key, next);
		const editsAtSend = (editCounts.get(key) ?? 0) + 1;
		editCounts.set(key, editsAtSend);
		notify();
		savesInFlight.set(key, (savesInFlight.get(key) ?? 0) + 1);
		Promise.resolve()
			.then(send)
			.then((saved) => {
				const settledHere = (savesInFlight.get(key) ?? 1) === 1 && editCounts.get(key) === editsAtSend;
				if (settledHere && saved && JSON.stringify(cache.get(key)) !== JSON.stringify(saved)) {
					cache.set(key, saved);
					notify();
				}
			})
			.catch((err) => {
				failed = true;
				console.warn("[board-views] failed to save view state:", err);
			})
			.finally(() => {
				savesInFlight.set(key, (savesInFlight.get(key) ?? 1) - 1);
				// A named view is the user's content: say it did not save, and show the file as it is.
				if (failed && named) {
					onNamedFailedRef.current?.();
					void readViewState({ kind: boardKind, id: boardId });
				}
			});
	}, [key, boardKind, boardId]);
	const update = useCallback((change: (state: BoardViewState) => BoardViewState) => {
		const base = stateRef.current;
		const next = change(base);
		if (next === base) return;
		commit(next, () => api.request.setBoardViewState({ board: { kind: boardKind, id: boardId }, state: next }));
	}, [commit, boardKind, boardId]);
	const changeNamed = useCallback((change: NamedViewChange) => {
		const base = stateRef.current;
		const next = applyNamedViewChange(base, change);
		if (next === base) return;
		commit(next, () => api.request.changeNamedBoardView({ board: { kind: boardKind, id: boardId }, change }), true);
	}, [commit, boardKind, boardId]);

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
	const appliedKey = `${key}:${formFactor}`;
	const namedViews = useMemo(() => namedSavedViews(state), [state]);
	const appliedId = useSyncExternalStore(subscribe, () => appliedNamed.get(appliedKey));
	const appliedNamedId = appliedId && namedViews.some((named) => named.id === appliedId) ? appliedId : null;
	const setApplied = useCallback((id: string | null) => {
		if (id) appliedNamed.set(appliedKey, id);
		else appliedNamed.delete(appliedKey);
		notify();
	}, [appliedKey]);

	const clearApplied = useCallback(() => {
		if (appliedNamed.has(appliedKey)) setApplied(null);
	}, [appliedKey, setApplied]);
	const appliedNamedModified = useCallback(
		(query: string) => !!appliedNamedId && namedViewModified(state, formFactor, appliedNamedId, query),
		[state, formFactor, appliedNamedId],
	);
	const saveNamed = useCallback((name: string, query: string) => {
		const change = namedViewAddChange(stateRef.current, formFactor, name, query);
		changeNamed(change);
		setApplied(change.view.id);
	}, [changeNamed, formFactor, setApplied]);
	const applyNamed = useCallback((id: string) => {
		const named = namedSavedViews(stateRef.current).find((candidate) => candidate.id === id);
		if (!named) return null;
		update((current) => withNamedViewApplied(current, formFactor, id));
		setApplied(id);
		return named.query;
	}, [update, formFactor, setApplied]);
	const updateNamed = useCallback(
		(id: string, query: string) => changeNamed(namedViewUpdateChange(stateRef.current, formFactor, id, query)),
		[changeNamed, formFactor],
	);
	const renameNamed = useCallback((id: string, name: string) => changeNamed({ kind: "rename", id, name }), [changeNamed]);
	const deleteNamed = useCallback((id: string) => {
		changeNamed({ kind: "delete", id });
		// Both form factors: a stale entry must not survive to claim a view saved later.
		for (const [appliedKeyOf, appliedIdOf] of appliedNamed) {
			if (appliedIdOf === id && appliedKeyOf.startsWith(`${key}:`)) appliedNamed.delete(appliedKeyOf);
		}
		notify();
	}, [changeNamed, key]);

	return {
		viewType: view.viewType, layout, setLayout, setViewType,
		namedViews, appliedNamedId, appliedNamedModified, saveNamed, applyNamed, updateNamed, renameNamed, deleteNamed,
		clearApplied,
	};
}
