import { useEffect, useRef } from "react";
import { api } from "../rpc";
import type { BoardRef } from "../../shared/board-view-state";
import { hasRememberedFilter } from "../hooks/useRememberedFilter";
import { facetToken, statusFilterValues } from "../utils/taskSearch";

// Per filter key and module-wide, so state outlives a component remount:
// `lastKnown` is the status list (JSON) the file holds or is being sent,
// `settled` means no more reads this session, `edited` means the user changed the query.
const lastKnown = new Map<string, string>();
const settled = new Set<string>();
const edited = new Set<string>();

interface WriteSlot {
	board: BoardRef;
	desired: string[] | null;
	inFlight: boolean;
}
const writes = new Map<string, WriteSlot>();

export function resetPersistedStatusFilterForTests(): void {
	lastKnown.clear();
	settled.clear();
	edited.clear();
	writes.clear();
}

// One request per board at a time, newest list wins: the host file lock is not FIFO,
// and an unmounted board must still get its last write.
function pump(slot: WriteSlot): void {
	if (slot.inFlight || slot.desired === null) return;
	const statuses = slot.desired;
	slot.desired = null;
	slot.inFlight = true;
	// Deferred so a transport without this method (an older host) rejects instead of throwing.
	Promise.resolve()
		.then(() => api.request.setBoardFilterState({ board: slot.board, state: { statuses } }))
		.catch((err) => console.warn("[board-filter] failed to save status filter:", err))
		.finally(() => {
			slot.inFlight = false;
			pump(slot);
		});
}

function enqueueWrite(key: string, board: BoardRef, statuses: string[]): void {
	const slot = writes.get(key) ?? { board, desired: null, inFlight: false };
	writes.set(key, slot);
	slot.board = board;
	slot.desired = statuses;
	pump(slot);
}

/**
 * Persists the `status:` tokens of a board's filter across restarts; every other part of
 * the query stays in memory. A user edit always wins over a pending read, and a failed
 * read or write never blocks the board.
 */
export function usePersistedStatusFilter(
	board: BoardRef,
	key: string,
	query: string,
	setQuery: (query: string) => void,
): void {
	const queryRef = useRef(query);
	queryRef.current = query;
	// The query that is not a user edit: what the board opened with, or what we restored.
	const seenRef = useRef(query);

	const boardKind = board.kind;
	const boardId = board.id;
	useEffect(() => {
		seenRef.current = queryRef.current;
		if (settled.has(key)) return;
		// An in-memory filter on first visit (a preset jump) wins over the file.
		if (hasRememberedFilter(key)) {
			settled.add(key);
			if (!lastKnown.has(key)) lastKnown.set(key, JSON.stringify(statusFilterValues(queryRef.current)));
			return;
		}
		let cancelled = false;
		Promise.resolve()
			.then(() => api.request.getBoardFilterState({ board: { kind: boardKind, id: boardId } }))
			.then(({ statuses }) => {
				if (cancelled) return;
				settled.add(key);
				if (edited.has(key) || queryRef.current !== seenRef.current) {
					// Typed statuses must be saved, never replaced by a bare [].
					edited.add(key);
					if (!lastKnown.has(key)) lastKnown.set(key, "[]");
					return;
				}
				lastKnown.set(key, JSON.stringify(statuses));
				if (statuses.length > 0) {
					const restored = statuses.map((s) => facetToken("status", s)).join(" ");
					seenRef.current = restored;
					setQuery(restored);
				}
			})
			.catch((err) => console.warn("[board-filter] failed to read status filter:", err));
		return () => {
			cancelled = true;
		};
	}, [key, boardKind, boardId, setQuery]);

	useEffect(() => {
		if (query !== seenRef.current) {
			edited.add(key);
			settled.add(key);
			if (!lastKnown.has(key)) lastKnown.set(key, "[]");
		}
		if (!edited.has(key)) return;
		const statuses = statusFilterValues(query);
		const json = JSON.stringify(statuses);
		if (lastKnown.get(key) === json) return;
		lastKnown.set(key, json);
		enqueueWrite(key, { kind: boardKind, id: boardId }, statuses);
	}, [query, key, boardKind, boardId]);
}
