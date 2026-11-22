import { useSyncExternalStore } from "react";

/**
 * One task's dock: which panels are open (in opening order) and which tab is in front.
 * A `floating` panel is open but not in the dock: it has no tab and draws itself as a
 * lightbox (the artifact viewer under the popup preference, or opened from a paneless surface).
 */
export interface TaskDockState {
	open: readonly string[];
	active: string | null;
	floating: readonly string[];
}

/**
 * A task's seat: the pane that shows its workspace. `element` is the dock body
 * when the pane has room for a dock; `null` while it shows the task without one
 * (narrow viewport, immersive). No seat at all = the task is not on screen.
 */
interface Seat {
	owner: object;
	element: HTMLElement | null;
}

const ACTIVE_KEY = "dev3-task-dock-active";
const MAX_REMEMBERED = 200;
const EMPTY: TaskDockState = { open: [], active: null, floating: [] };

const docks = new Map<string, TaskDockState>();
const seats = new Map<string, Seat>();
const listeners = new Set<() => void>();
let docksSnapshot: ReadonlyMap<string, TaskDockState> = new Map();
let seatsVersion = 0;

function readRemembered(): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "{}");
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** The user's last tab pick per task, newest last, capped so it cannot grow forever. */
function remember(taskId: string, panelId: string): void {
	const remembered = readRemembered();
	delete remembered[taskId];
	remembered[taskId] = panelId;
	const ids = Object.keys(remembered);
	for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED))) delete remembered[stale];
	try {
		localStorage.setItem(ACTIVE_KEY, JSON.stringify(remembered));
	} catch { /* storage full or blocked: the pick only lasts this session */ }
}

function changed(): void {
	docksSnapshot = new Map(docks);
	for (const listener of listeners) listener();
}

function setDock(taskId: string, next: TaskDockState): void {
	if (next.open.length === 0) docks.delete(taskId);
	else docks.set(taskId, next);
	changed();
}

export function getTaskDock(taskId: string): TaskDockState {
	return docks.get(taskId) ?? EMPTY;
}

/**
 * The tab that is really in front among `available` (the open panels that are registered
 * and not dropped): the stored front tab if it is there, else the user's last pick, else
 * the newest. Keeps a selected, Tab-reachable tab when the stored one went away.
 */
export function resolveActiveTab(taskId: string, available: readonly string[], active: string | null): string | null {
	if (active !== null && available.includes(active)) return active;
	const remembered = readRemembered()[taskId];
	if (remembered && available.includes(remembered)) return remembered;
	return available[available.length - 1] ?? null;
}

/** Every task that has an open panel. The same map until something changes. */
export function getTaskDocks(): ReadonlyMap<string, TaskDockState> {
	return docksSnapshot;
}

/**
 * Opens a panel's tab for a task. `activate` brings it to the front; otherwise it
 * goes in front only when the user last picked it here, or nothing else is open.
 */
export function openTaskPanel(taskId: string, panelId: string, { activate = true, floating = false }: { activate?: boolean; floating?: boolean } = {}): void {
	const dock = getTaskDock(taskId);
	const open = dock.open.includes(panelId) ? dock.open : [...dock.open, panelId];
	const wasFloating = dock.floating.includes(panelId);
	const floats = floating === wasFloating ? dock.floating : floating ? [...dock.floating, panelId] : dock.floating.filter((id) => id !== panelId);
	let active = dock.active;
	if (floating) {
		if (active === panelId) active = null;
	} else if (activate || active === null || readRemembered()[taskId] === panelId) {
		active = panelId;
	}
	if (open === dock.open && active === dock.active && floats === dock.floating) return;
	setDock(taskId, { open, active, floating: floats });
}

/** The open panels that sit in the dock as tabs: every open one that is not floating. */
export function dockedPanelIds(dock: TaskDockState): readonly string[] {
	return dock.floating.length === 0 ? dock.open : dock.open.filter((id) => !dock.floating.includes(id));
}

export function closeTaskPanel(taskId: string, panelId: string): void {
	const dock = getTaskDock(taskId);
	if (!dock.open.includes(panelId)) return;
	const open = dock.open.filter((id) => id !== panelId);
	const floating = dock.floating.filter((id) => id !== panelId);
	let active = dock.active;
	if (active === panelId) active = resolveActiveTab(taskId, open.filter((id) => !floating.includes(id)), null);
	setDock(taskId, { open, active, floating });
}

/** The user picked a tab: it goes in front and is remembered for this task. */
export function activateTaskPanel(taskId: string, panelId: string): void {
	const dock = getTaskDock(taskId);
	if (!dock.open.includes(panelId) || dock.floating.includes(panelId)) return;
	remember(taskId, panelId);
	if (dock.active !== panelId) setDock(taskId, { ...dock, active: panelId });
}

/** Claims the task's seat for `owner`; `undefined` releases it, but only `owner`'s own. */
export function setTaskDockSeat(taskId: string, owner: object, element: HTMLElement | null | undefined): void {
	const current = seats.get(taskId);
	if (element === undefined) {
		if (current?.owner !== owner) return;
		seats.delete(taskId);
	} else {
		if (current?.owner === owner && current.element === element) return;
		seats.set(taskId, { owner, element });
	}
	seatsVersion++;
	for (const listener of listeners) listener();
}

/** `undefined`: the task is not on screen; `null`: on screen with no room for a dock. */
export function getTaskDockSeat(taskId: string): HTMLElement | null | undefined {
	const seat = seats.get(taskId);
	return seat ? seat.element : undefined;
}

/** Bumps whenever any seat changes, so a hook can re-read `getTaskDockSeat`. */
export function getTaskDockSeatsVersion(): number {
	return seatsVersion;
}

export function subscribeTaskDocks(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useTaskDock(taskId: string): TaskDockState {
	return useSyncExternalStore(subscribeTaskDocks, () => getTaskDock(taskId));
}

export function resetTaskDocksForTests(): void {
	docks.clear();
	seats.clear();
	seatsVersion = 0;
	changed();
}
