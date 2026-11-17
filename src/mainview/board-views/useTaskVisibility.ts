import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../rpc";
import type { BoardRef } from "../../shared/board-view-state";
import type { TaskVisibility } from "../../shared/board-filter-state";

interface VisibilitySnapshot {
	value: TaskVisibility;
	/** The saved value has been read (or failed to), or the user already chose. */
	ready: boolean;
}

interface VisibilitySlot {
	board: BoardRef;
	snapshot: VisibilitySnapshot;
	// A user set before the read lands wins over the read.
	edited: boolean;
	/** A successful read has landed: no more reads this session. */
	loaded: boolean;
	reading: boolean;
	attempt: number;
	desired: TaskVisibility | null;
	inFlight: boolean;
	listeners: Set<() => void>;
	subscribe: (listener: () => void) => () => void;
}

// Module-wide, so a board's visibility survives a remount and A -> B -> A does not re-read.
const slots = new Map<string, VisibilitySlot>();

export function resetTaskVisibilityForTests(): void {
	slots.clear();
}

function slotFor(board: BoardRef): VisibilitySlot {
	const key = `${board.kind}:${board.id}`;
	let slot = slots.get(key);
	if (!slot) {
		const created: VisibilitySlot = {
			board: { kind: board.kind, id: board.id },
			snapshot: { value: "all", ready: false },
			edited: false,
			loaded: false,
			reading: false,
			attempt: 0,
			desired: null,
			inFlight: false,
			listeners: new Set(),
			subscribe: (listener) => {
				created.listeners.add(listener);
				return () => { created.listeners.delete(listener); };
			},
		};
		slot = created;
		slots.set(key, slot);
	}
	return slot;
}

function publish(slot: VisibilitySlot, snapshot: VisibilitySnapshot): void {
	slot.snapshot = snapshot;
	for (const listener of slot.listeners) listener();
}

// One request per board at a time, newest value wins: the host file lock is not FIFO.
function pump(slot: VisibilitySlot): void {
	if (slot.inFlight || slot.desired === null) return;
	const visibility = slot.desired;
	slot.desired = null;
	slot.inFlight = true;
	// Deferred so a transport without this method (an older host) rejects instead of throwing.
	Promise.resolve()
		.then(() => api.request.setBoardFilterState({ board: slot.board, state: { visibility } }))
		.catch((err) => console.warn("[task-visibility] failed to save:", err))
		.finally(() => {
			slot.inFlight = false;
			pump(slot);
		});
}

// Lets a silent (lost) request stop holding the board hidden; the transport itself waits 6 minutes.
export const VISIBILITY_READ_TIMEOUT_MS = 3_000;

function settle(slot: VisibilitySlot): void {
	if (!slot.snapshot.ready) publish(slot, { ...slot.snapshot, ready: true });
}

// A failed or timed-out read settles the board as "all" and is retried on the next mount;
// a late success still applies unless the user already chose.
function startRead(slot: VisibilitySlot): void {
	if (slot.loaded || slot.edited || slot.reading) return;
	slot.reading = true;
	const attempt = ++slot.attempt;
	const endAttempt = () => {
		if (slot.attempt === attempt) slot.reading = false;
	};
	const timer = setTimeout(() => {
		console.warn("[task-visibility] read timed out");
		endAttempt();
		settle(slot);
	}, VISIBILITY_READ_TIMEOUT_MS);
	Promise.resolve()
		.then(() => api.request.getBoardFilterState({ board: slot.board }))
		.then(({ visibility }) => {
			clearTimeout(timer);
			endAttempt();
			if (slot.loaded) return;
			slot.loaded = true;
			publish(slot, { value: slot.edited ? slot.snapshot.value : visibility, ready: true });
		})
		.catch((err) => {
			clearTimeout(timer);
			endAttempt();
			console.warn("[task-visibility] failed to read:", err);
			settle(slot);
		});
}

export interface TaskVisibilityState {
	visibility: TaskVisibility;
	setVisibility: (visibility: TaskVisibility) => void;
	/** False until the board's saved value has settled; render the board only once it is true. */
	ready: boolean;
}

/**
 * The board's Active | All choice, remembered per board across restarts. A failed read
 * settles as "all" and a failed write only logs: neither blocks the board.
 */
export function useTaskVisibility(board: BoardRef): TaskVisibilityState {
	const slot = slotFor(board);
	const snapshot = useSyncExternalStore(slot.subscribe, () => slot.snapshot);
	useEffect(() => startRead(slot), [slot]);

	const setVisibility = useCallback((visibility: TaskVisibility) => {
		slot.edited = true;
		publish(slot, { value: visibility, ready: true });
		slot.desired = visibility;
		pump(slot);
	}, [slot]);

	return { visibility: snapshot.value, setVisibility, ready: snapshot.ready };
}
