import { useEffect, useMemo, useState } from "react";
import type { Epic, EpicMember, EpicsFile, Task } from "../../shared/types";
import { api } from "../rpc";

/**
 * The renderer's one copy of the global epic registry and of who is in which
 * epic. Each is fetched once and kept live by pushes: the registry by
 * `epicsUpdated`, membership by task updates that touch an epic.
 */
type Store<T> = { value: T; subscribers: Set<(value: T) => void>; listening: boolean };

const epicsStore: Store<Epic[]> = { value: [], subscribers: new Set(), listening: false };
const membersStore: Store<EpicMember[]> = { value: [], subscribers: new Set(), listening: false };
let membersTimer: ReturnType<typeof setTimeout> | null = null;

const MEMBERS_REFETCH_DEBOUNCE_MS = 400;

function publish<T>(store: Store<T>, value: T): void {
	store.value = value;
	for (const notify of store.subscribers) notify(value);
}

function fetchEpics(): void {
	Promise.resolve()
		.then(() => api.request.getEpics({}))
		.then((file) => publish(epicsStore, file.epics))
		.catch((err) => console.error("getEpics failed", err));
}

function fetchMembers(): void {
	Promise.resolve()
		.then(() => api.request.getEpicMembers({}))
		.then((members) => publish(membersStore, members))
		.catch((err) => console.error("getEpicMembers failed", err));
}

function scheduleMembersRefetch(): void {
	if (membersTimer) clearTimeout(membersTimer);
	membersTimer = setTimeout(() => {
		membersTimer = null;
		fetchMembers();
	}, MEMBERS_REFETCH_DEBOUNCE_MS);
}

function onEpicsUpdated(e: Event): void {
	const file = (e as CustomEvent<{ file?: EpicsFile }>).detail?.file;
	if (file) publish(epicsStore, file.epics);
}

/** True when this update can change who is in which epic. */
export function epicMembershipChangedBy(task: Task, members: readonly EpicMember[]): boolean {
	const known = members.find((m) => m.id === task.id);
	if (!known) return Boolean(task.epicId);
	return known.epicId !== task.epicId || known.status !== task.status || known.seq !== task.seq || known.projectId !== task.projectId;
}

function onTaskUpdated(e: Event): void {
	const task = (e as CustomEvent<{ task?: Task }>).detail?.task;
	if (task && epicMembershipChangedBy(task, membersStore.value)) scheduleMembersRefetch();
}

function onTaskRemoved(e: Event): void {
	const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
	if (taskId && membersStore.value.some((m) => m.id === taskId)) scheduleMembersRefetch();
}

function useStore<T>(store: Store<T>, start: () => void): T {
	const [value, setValue] = useState<T>(store.value);
	useEffect(() => {
		store.subscribers.add(setValue);
		if (!store.listening) {
			store.listening = true;
			start();
		} else {
			setValue(store.value);
		}
		return () => {
			store.subscribers.delete(setValue);
		};
	}, [store, start]);
	return value;
}

function startEpics(): void {
	window.addEventListener("rpc:epicsUpdated", onEpicsUpdated);
	fetchEpics();
}

function startMembers(): void {
	window.addEventListener("rpc:taskUpdated", onTaskUpdated);
	window.addEventListener("rpc:taskRemoved", onTaskRemoved);
	fetchMembers();
}

/** Every epic, archived included, plus an id lookup. */
export function useEpics(): { epics: Epic[]; byId: ReadonlyMap<string, Epic> } {
	const epics = useStore(epicsStore, startEpics);
	const byId = useMemo(() => new Map(epics.map((e) => [e.id, e])), [epics]);
	return { epics, byId };
}

/** Every task in any epic, across all projects. */
export function useEpicMembers(): EpicMember[] {
	return useStore(membersStore, startMembers);
}

export function _resetEpicStoresForTest(): void {
	for (const store of [epicsStore, membersStore] as Store<unknown>[]) {
		store.value = [];
		store.subscribers.clear();
		store.listening = false;
	}
	if (membersTimer) clearTimeout(membersTimer);
	membersTimer = null;
	window.removeEventListener("rpc:epicsUpdated", onEpicsUpdated);
	window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	window.removeEventListener("rpc:taskRemoved", onTaskRemoved);
}
