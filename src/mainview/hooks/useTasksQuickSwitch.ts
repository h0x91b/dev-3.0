import { useCallback, useEffect, useRef, useState } from "react";
import type {
	GlobalSettings as GlobalSettingsType,
	Project,
	Task,
	TasksQuickSwitchShortcut,
} from "../../shared/types";
import {
	normalizeTasksQuickSwitchFilters,
	normalizeTasksQuickSwitchShortcut,
} from "../../shared/types";
import { api } from "../rpc";
import type { Route } from "../state";
import { useGlobalShortcut } from "./useGlobalShortcut";
import {
	buildTasksQuickSwitchItems,
	buildQuickSwitchOpenTaskRoute,
	getActiveQuickSwitchRouteTaskId,
	getInitialTasksQuickSwitchIndex,
	getQuickSwitchDirection,
	moveTasksQuickSwitchSelection,
	syncTasksQuickSwitchProjectTasks,
	type TasksQuickSwitchItem,
} from "../tasks-quick-switch";
import {
	areQuickSwitchShortcutModifiersStillPressed,
	isQuickSwitchShortcutPressed,
	isTasksQuickSwitchShortcutModalOpen,
} from "../tasks-quick-switch-shortcut";
import {
	DEFAULT_GLOBAL_SETTINGS,
	getStoredTasksQuickSwitchShortcut,
} from "../components/global-settings/utils";

export interface TasksQuickSwitchSession {
	items: TasksQuickSwitchItem[];
	selectedIndex: number;
	originTaskId: string | null;
	shortcut: TasksQuickSwitchShortcut;
}

interface UseTasksQuickSwitchParams {
	navigate: (route: Route) => void;
	projects: Project[];
	recentTaskIds: string[];
	route: Route;
}

export function useTasksQuickSwitch({
	navigate,
	projects,
	recentTaskIds,
	route,
}: UseTasksQuickSwitchParams) {
	const [quickSwitchSettings, setQuickSwitchSettings] =
		useState<GlobalSettingsType>(() => ({
			...DEFAULT_GLOBAL_SETTINGS,
			tasksQuickSwitchShortcut: getStoredTasksQuickSwitchShortcut(),
		}));
	const [quickSwitchTasksByProject, setQuickSwitchTasksByProject] = useState<
		Map<string, Task[]>
	>(new Map());
	const [quickSwitchSession, setQuickSwitchSession] =
		useState<TasksQuickSwitchSession | null>(null);

	const quickSwitchSessionRef = useRef<TasksQuickSwitchSession | null>(null);
	const quickSwitchStartingRef = useRef(false);
	const quickSwitchLocalSettingsVersionRef = useRef(0);
	const quickSwitchSettingsRef = useRef<GlobalSettingsType>(quickSwitchSettings);

	const setQuickSwitchSettingsState = useCallback((settings: GlobalSettingsType) => {
		quickSwitchSettingsRef.current = settings;
		setQuickSwitchSettings(settings);
	}, []);

	useEffect(() => {
		quickSwitchSessionRef.current = quickSwitchSession;
	}, [quickSwitchSession]);

	useEffect(() => {
		const localSettingsVersionAtStart =
			quickSwitchLocalSettingsVersionRef.current;

		api.request.getGlobalSettings().then((settings) => {
			if (
				quickSwitchLocalSettingsVersionRef.current !==
				localSettingsVersionAtStart
			) {
				return;
			}
			setQuickSwitchSettingsState(settings);
		}).catch(() => {});
	}, [setQuickSwitchSettingsState]);

	useEffect(() => {
		function onGlobalSettingsChanged(event: Event) {
			quickSwitchLocalSettingsVersionRef.current += 1;
			setQuickSwitchSettingsState(
				(event as CustomEvent<GlobalSettingsType>).detail,
			);
		}

		window.addEventListener(
			"dev3:globalSettingsChanged",
			onGlobalSettingsChanged,
		);
		return () =>
			window.removeEventListener(
				"dev3:globalSettingsChanged",
				onGlobalSettingsChanged,
			);
	}, [setQuickSwitchSettingsState]);

	const beginTasksQuickSwitch = useCallback(
		async (direction: 1 | -1) => {
			if (quickSwitchStartingRef.current) return;
			quickSwitchStartingRef.current = true;
			try {
				let resolvedSettings = quickSwitchSettingsRef.current;
				let resolvedTasksByProject = quickSwitchTasksByProject;

				// Always refetch — a push-message miss or a race with the backend
				// would otherwise leave stale status labels (e.g. a task that moved
				// to Completed still showing as "Your Review"). Fall back to the
				// last known cache if the fetch fails.
				const tasksResult = await api.request.getTasksQuickSwitchTasks()
					.then((value) => ({ status: "fulfilled" as const, value }))
					.catch((reason) => ({ status: "rejected" as const, reason }));

				if (tasksResult.status === "fulfilled") {
					resolvedTasksByProject = new Map<string, Task[]>(
						tasksResult.value.map(({ projectId, tasks }) => [projectId, tasks]),
					);
					setQuickSwitchTasksByProject(resolvedTasksByProject);
				}

				const items = buildTasksQuickSwitchItems({
					projects,
					recentTaskIds,
					allowedFilters: normalizeTasksQuickSwitchFilters(
						resolvedSettings.tasksQuickSwitchFilters ??
						resolvedSettings.tasksQuickSwitchStatuses,
					),
					tasksByProject: resolvedTasksByProject,
				});
				const originTaskId = getActiveQuickSwitchRouteTaskId(route);
				const shortcut = normalizeTasksQuickSwitchShortcut(
					resolvedSettings.tasksQuickSwitchShortcut,
					resolvedSettings.tasksQuickSwitchShortcutModifier,
				);
				setQuickSwitchSession({
					items,
					selectedIndex: getInitialTasksQuickSwitchIndex(
						items,
						originTaskId,
						direction,
					),
					originTaskId,
					shortcut,
				});
			} finally {
				quickSwitchStartingRef.current = false;
			}
		},
		[projects, quickSwitchTasksByProject, recentTaskIds, route],
	);

	const moveTasksQuickSwitch = useCallback((direction: 1 | -1) => {
		setQuickSwitchSession((current) => {
			if (!current || current.items.length === 0) {
				return current;
			}
			return {
				...current,
				selectedIndex: moveTasksQuickSwitchSelection(
					current.selectedIndex,
					current.items.length,
					direction,
				),
			};
		});
	}, []);

	const closeTasksQuickSwitch = useCallback(
		(commit: boolean) => {
			const session = quickSwitchSessionRef.current;
			setQuickSwitchSession(null);
			if (!commit || !session) return;
			const selected = session.items[session.selectedIndex];
			if (!selected || selected.taskId === session.originTaskId) return;
			navigate(
				buildQuickSwitchOpenTaskRoute(
					selected.projectId,
					selected.taskId,
					localStorage.getItem("dev3-task-open-mode") as "split" | "fullscreen" | null,
				),
			);
		},
		[navigate],
	);

	useGlobalShortcut(
		(e) => {
			if (isTasksQuickSwitchShortcutModalOpen()) {
				return;
			}
			const liveSettings = quickSwitchSettingsRef.current;
			const shortcut = normalizeTasksQuickSwitchShortcut(
				liveSettings.tasksQuickSwitchShortcut,
				liveSettings.tasksQuickSwitchShortcutModifier,
			);
			if (isQuickSwitchShortcutPressed(e, shortcut)) {
				e.preventDefault();
				e.stopImmediatePropagation();
				e.stopPropagation();
				if (quickSwitchSessionRef.current) {
					moveTasksQuickSwitch(getQuickSwitchDirection(e, shortcut));
				} else {
					void beginTasksQuickSwitch(getQuickSwitchDirection(e, shortcut));
				}
				return;
			}

			if (!quickSwitchSessionRef.current) return;

			if (e.key === "ArrowRight" || e.key === "ArrowDown") {
				e.preventDefault();
				e.stopImmediatePropagation();
				e.stopPropagation();
				moveTasksQuickSwitch(1);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
				e.preventDefault();
				e.stopImmediatePropagation();
				e.stopPropagation();
				moveTasksQuickSwitch(-1);
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				e.stopPropagation();
				closeTasksQuickSwitch(false);
			}
		},
		[beginTasksQuickSwitch, closeTasksQuickSwitch, moveTasksQuickSwitch],
		{ capture: true },
	);

	useEffect(() => {
		function onKeyUp(event: KeyboardEvent) {
			if (
				quickSwitchSessionRef.current &&
				!areQuickSwitchShortcutModifiersStillPressed(
					event,
					quickSwitchSessionRef.current.shortcut,
				)
			) {
				closeTasksQuickSwitch(true);
			}
		}

		function onBlur() {
			if (quickSwitchSessionRef.current) {
				closeTasksQuickSwitch(true);
			}
		}

		window.addEventListener("keyup", onKeyUp, { capture: true });
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keyup", onKeyUp, { capture: true });
			window.removeEventListener("blur", onBlur);
		};
	}, [closeTasksQuickSwitch]);

	const syncQuickSwitchTask = useCallback((task: Task) => {
		setQuickSwitchTasksByProject((prev) =>
			syncTasksQuickSwitchProjectTasks(prev, task),
		);
	}, []);

	return {
		quickSwitchSession,
		syncQuickSwitchTask,
	};
}
