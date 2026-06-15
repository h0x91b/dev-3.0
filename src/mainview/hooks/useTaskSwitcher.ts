import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../../shared/types";
import { ACTIVE_STATUSES } from "../../shared/types";
import { api } from "../rpc";
import type { Route } from "../state";
import { isMac } from "../utils/platform";

export type SwitcherScope = "project" | "global";

export interface SwitcherSession {
	scope: SwitcherScope;
	items: Task[];
	index: number;
}

interface UseTaskSwitcherArgs {
	/** Active + inactive tasks of the currently open project. */
	projectTasks: Task[];
	/** Project id of the current view, or null on non-project screens. */
	currentProjectId: string | null;
	/** Task id the current route is showing, or null. */
	currentTaskId: string | null;
	/** MRU task ids, newest first (from app state). */
	mru: string[];
	navigate: (route: Route) => void;
}

/**
 * Order candidates by MRU (newest first), then append never-visited tasks by
 * descending seq so every active task is still reachable.
 */
export function orderByMru(candidates: Task[], mru: string[]): Task[] {
	const byId = new Map(candidates.map((t) => [t.id, t]));
	const ordered: Task[] = [];
	const used = new Set<string>();
	for (const id of mru) {
		const t = byId.get(id);
		if (t && !used.has(id)) {
			ordered.push(t);
			used.add(id);
		}
	}
	const rest = candidates
		.filter((t) => !used.has(t.id))
		.sort((a, b) => b.seq - a.seq);
	return [...ordered, ...rest];
}

function activeOf(tasks: Task[]): Task[] {
	return tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
}

/**
 * Option+Tab (project) / Option+Shift+Tab (global) hold-cycle task switcher.
 * On Linux the window manager grabs Alt+Tab, so the binding falls back to
 * Ctrl+Tab / Ctrl+Shift+Tab there.
 *
 * Hold the modifier, tap Tab to advance (wrap-around), release to commit.
 * Arrows ↑/↓ move both ways; Enter commits; Escape cancels. Order is MRU so a
 * quick tap-tap toggles the two most recent tasks.
 */
export function useTaskSwitcher({
	projectTasks,
	currentProjectId,
	currentTaskId,
	mru,
	navigate,
}: UseTaskSwitcherArgs) {
	const [session, setSession] = useState<SwitcherSession | null>(null);
	const [globalTasks, setGlobalTasks] = useState<Task[]>([]);

	// Live mirrors read by the window-level listeners (avoid stale closures).
	const sessionRef = useRef<SwitcherSession | null>(null);
	sessionRef.current = session;
	const projectTasksRef = useRef(projectTasks);
	projectTasksRef.current = projectTasks;
	const globalTasksRef = useRef(globalTasks);
	globalTasksRef.current = globalTasks;
	const currentProjectIdRef = useRef(currentProjectId);
	currentProjectIdRef.current = currentProjectId;
	const currentTaskIdRef = useRef(currentTaskId);
	currentTaskIdRef.current = currentTaskId;
	const mruRef = useRef(mru);
	mruRef.current = mru;
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;

	// Keep a live snapshot of all-project active tasks so the global switcher
	// opens instantly. Mirrors ActiveTasksSidebar's global-scope plumbing.
	const refreshGlobal = useCallback(async () => {
		try {
			const results = await api.request.getAllProjectTasks();
			const flat: Task[] = [];
			for (const { tasks } of results) {
				for (const task of tasks) flat.push(task);
			}
			setGlobalTasks(flat);
		} catch {
			/* best-effort; project scope still works */
		}
	}, []);

	useEffect(() => {
		void refreshGlobal();
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent).detail as { task: Task };
			setGlobalTasks((prev) => {
				const idx = prev.findIndex((t) => t.id === task.id);
				const isActive = ACTIVE_STATUSES.includes(task.status);
				if (isActive) {
					if (idx >= 0) {
						const next = prev.slice();
						next[idx] = task;
						return next;
					}
					return [...prev, task];
				}
				if (idx >= 0) {
					const next = prev.slice();
					next.splice(idx, 1);
					return next;
				}
				return prev;
			});
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, [refreshGlobal]);

	const cancel = useCallback(() => setSession(null), []);

	const commit = useCallback((indexOverride?: number) => {
		const s = sessionRef.current;
		setSession(null);
		if (!s) return;
		const idx = indexOverride ?? s.index;
		const task = s.items[idx];
		if (!task) return;
		const fullscreen = localStorage.getItem("dev3-task-open-mode") === "fullscreen";
		navigateRef.current(
			fullscreen
				? { screen: "task", projectId: task.projectId, taskId: task.id }
				: { screen: "project", projectId: task.projectId, activeTaskId: task.id },
		);
	}, []);

	const setIndex = useCallback((index: number) => {
		setSession((s) => (s ? { ...s, index } : s));
	}, []);

	const advance = useCallback((delta: number) => {
		setSession((s) => {
			if (!s || s.items.length === 0) return s;
			const n = s.items.length;
			const index = (((s.index + delta) % n) + n) % n;
			return { ...s, index };
		});
	}, []);

	const open = useCallback(
		(scope: SwitcherScope): boolean => {
			const source =
				scope === "global"
					? globalTasksRef.current
					: projectTasksRef.current.filter(
							(t) => t.projectId === currentProjectIdRef.current,
						);
			const items = orderByMru(activeOf(source), mruRef.current);
			if (items.length === 0) return false;
			const cur = currentTaskIdRef.current;
			const startIndex =
				cur && items[0]?.id === cur && items.length > 1 ? 1 : 0;
			setSession({ scope, items, index: startIndex });
			if (scope === "global") void refreshGlobal();
			return true;
		},
		[refreshGlobal],
	);

	// While a global session is open, fold in any freshly-fetched tasks without
	// disturbing the highlighted entry.
	useEffect(() => {
		if (!session || session.scope !== "global") return;
		const items = orderByMru(activeOf(globalTasks), mruRef.current);
		setSession((s) => {
			if (!s || s.scope !== "global") return s;
			const currentId = s.items[s.index]?.id;
			const index = Math.max(0, items.findIndex((t) => t.id === currentId));
			if (
				items.length === s.items.length &&
				items.every((t, i) => t.id === s.items[i]?.id)
			) {
				return s;
			}
			return { ...s, items, index };
		});
		// Only react to the global task list changing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [globalTasks]);

	useEffect(() => {
		const modIsAlt = isMac();
		const onKeyDown = (e: KeyboardEvent) => {
			const s = sessionRef.current;
			if (s) {
				if (e.key === "Tab") {
					e.preventDefault();
					e.stopPropagation();
					if (!e.repeat) advance(1);
					return;
				}
				if (e.key === "ArrowDown" || e.key === "ArrowRight") {
					e.preventDefault();
					e.stopPropagation();
					advance(1);
					return;
				}
				if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
					e.preventDefault();
					e.stopPropagation();
					advance(-1);
					return;
				}
				if (e.key === "Enter") {
					e.preventDefault();
					e.stopPropagation();
					commit();
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					cancel();
					return;
				}
				return;
			}
			if (e.key !== "Tab") return;
			const modDown = modIsAlt ? e.altKey : e.ctrlKey;
			const otherMeta = e.metaKey || (modIsAlt ? e.ctrlKey : e.altKey);
			if (!modDown || otherMeta) return;
			const scope: SwitcherScope = e.shiftKey ? "global" : "project";
			if (open(scope)) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (!sessionRef.current) return;
			const released = modIsAlt
				? e.key === "Alt" || !e.altKey
				: e.key === "Control" || !e.ctrlKey;
			if (released) commit();
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		window.addEventListener("keyup", onKeyUp, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
			window.removeEventListener("keyup", onKeyUp, { capture: true });
		};
	}, [advance, commit, cancel, open]);

	return { session, setIndex, commit, cancel };
}
