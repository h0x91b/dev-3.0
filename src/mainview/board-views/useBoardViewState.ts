import { useCallback, useEffect, useRef, useState } from "react";
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

function boardKey(board: BoardRef): string {
	return `${board.kind}:${board.id}`;
}

export function resetBoardViewStateCacheForTests(): void {
	cache.clear();
}

/**
 * The board's saved view selection and layouts (§4.4), read once per board and
 * written through on every change. A failed read or write keeps the in-memory
 * state: a view preference must never block the board.
 */
export function useBoardViewState(board: BoardRef, formFactor: BoardFormFactor): BoardViewStateHandle {
	const key = boardKey(board);
	const [entry, setEntry] = useState(() => ({ key, state: cache.get(key) ?? defaultBoardViewState() }));
	const current = entry.key === key ? entry : { key, state: cache.get(key) ?? defaultBoardViewState() };
	if (current !== entry) setEntry(current);
	// Writes made before the first read lands must win over that read.
	const dirtyRef = useRef(new Set<string>());

	const boardKind = board.kind;
	const boardId = board.id;
	useEffect(() => {
		let cancelled = false;
		// Deferred so a transport without this method (an older host) rejects instead of throwing.
		Promise.resolve()
			.then(() => api.request.getBoardViewState({ board: { kind: boardKind, id: boardId } }))
			.then((state) => {
				if (cancelled || dirtyRef.current.has(key)) return;
				cache.set(key, state);
				setEntry({ key, state });
			})
			.catch((err) => console.warn("[board-views] failed to read view state:", err));
		return () => {
			cancelled = true;
		};
	}, [key, boardKind, boardId]);

	const stateRef = useRef(current.state);
	stateRef.current = current.state;
	const update = useCallback((change: (state: BoardViewState) => BoardViewState) => {
		const base = stateRef.current;
		const next = change(base);
		if (next === base) return;
		stateRef.current = next;
		cache.set(key, next);
		dirtyRef.current.add(key);
		setEntry({ key, state: next });
		Promise.resolve()
			.then(() => api.request.setBoardViewState({ board: { kind: boardKind, id: boardId }, state: next }))
			.catch((err) => console.warn("[board-views] failed to save view state:", err));
	}, [key, boardKind, boardId]);

	const view = activeSavedView(current.state, formFactor);
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
