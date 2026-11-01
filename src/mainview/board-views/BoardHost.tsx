import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch } from "react";
import type { DevServerSummary, GlobalSettings, PortInfo, Project, ResourceUsage, Space, Task, TaskStatus } from "../../shared/types";
import { getBoardColumns, laneKey } from "../../shared/types";
import { KANBAN_VIEW_ID, type BoardFormFactor, type BoardRef } from "../../shared/board-view-state";
import { getTaskOpenMode, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { ignoreStartupReadFailure, startupRead } from "../startup-read";
import { useT } from "../i18n";
import LabelFilterBar from "../components/LabelFilterBar";
import LineageFilterNotice from "../components/LineageFilterNotice";
import CreateTaskModal from "../components/CreateTaskModal";
import TaskDetailModal from "../components/TaskDetailModal";
import { CAROUSEL_MAX_WIDTH } from "../components/MobileBoardCarousel";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useAgents } from "../hooks/useAgents";
import { boardFilterKey, rememberFilter } from "../hooks/useRememberedFilter";
import { childrenFilterToken, lineageChildren, lineageParent, parentSeqLabel, type CardLineage } from "../utils/taskLineage";
import { requestTaskLaunch } from "../utils/moveTaskToStatus";
import { useStreamerMode } from "../streamer-mode";
import { HIDDEN_CONTROLS_CHANGED_EVENT, isSimplifyViewApplied } from "../hidden-controls";
import { BoardService, type BoardModel, type BoardModelSource, type BoardPreferences } from "./board-service";
import { BoardCardBindingsContext, BoardTaskCard, type BoardCardBindings } from "./BoardTaskCard";
import { getBoardRoot } from "./root";
import { useRegisteredBoardViews } from "./react";
import { useBoardFilter } from "./useBoardFilter";
import { useBoardViewState } from "./useBoardViewState";
import { useBoardActions } from "./useBoardActions";
import { BoardViewErrorBoundary, BoardViewOptionsButton, BoardViewSlot, BoardViewSwitcher } from "./BoardViewChrome";
import { KanbanView } from "./kanban";

export interface BoardHostProps {
	/** The board's anchor project: the subject of a project board, the zoom-out origin of a space board. */
	project: Project;
	space?: Space | null;
	memberProjects?: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	bellReasons?: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
	taskDevServers: Map<string, DevServerSummary>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	activeTaskId?: string;
	disableGlobalFindShortcut?: boolean;
	onOpenUnresolvedComments?: (task: Task) => void;
	detailTaskId?: string;
	onCloseTaskDetail?: () => void;
	allProjects?: Project[];
}

const DEFAULT_PREFERENCES: BoardPreferences = { taskSortOrder: "oldest-first", tipsDisabled: false };

function toPreferences(settings: GlobalSettings): BoardPreferences {
	return { taskSortOrder: settings.taskSortOrder, tipsDisabled: settings.tipsDisabled === true };
}

/** The settings a view honours, following the push so another window's change reorders this board too. */
function useBoardPreferences(): BoardPreferences {
	const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
	useEffect(() => {
		let live = true;
		startupRead("global settings", () => api.request.getGlobalSettings(), { isCancelled: () => !live })
			.then((settings) => { if (live) setPreferences(toPreferences(settings)); })
			.catch(ignoreStartupReadFailure);
		function onSettingsUpdated(e: Event) {
			setPreferences(toPreferences((e as CustomEvent<GlobalSettings>).detail));
		}
		window.addEventListener("rpc:globalSettingsUpdated", onSettingsUpdated);
		return () => {
			live = false;
			window.removeEventListener("rpc:globalSettingsUpdated", onSettingsUpdated);
		};
	}, []);
	return preferences;
}

function subscribeHiddenControls(listener: () => void): () => void {
	window.addEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, listener);
	return () => window.removeEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, listener);
}

/**
 * A project or space board: the shared filter row, the active board view and
 * the `ctx.board` service every view reads (spec §4.1). Which view is active is
 * board state, not navigation — it never touches the route (D15).
 */
function BoardHost(props: BoardHostProps) {
	const { project, space, tasks, dispatch, navigate, taskPorts, allProjects, disableGlobalFindShortcut = false } = props;
	const t = useT();
	const agents = useAgents();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const formFactor: BoardFormFactor = isNarrow ? "narrow" : "wide";
	const simplified = useSyncExternalStore(subscribeHiddenControls, isSimplifyViewApplied);
	const filter = useBoardFilter({ project, space, memberProjects: props.memberProjects, tasks, agents, taskPorts, allProjects });
	const { boardProjects } = filter;

	const boardRef = useMemo<BoardRef>(
		() => (space ? { kind: "space", id: space.id } : { kind: "project", id: project.id }),
		[space, project.id],
	);
	const viewState = useBoardViewState(boardRef, formFactor);

	const preferences = useBoardPreferences();
	const isStreamerOn = useStreamerMode();

	const projectById = useMemo(() => new Map(boardProjects.map((p) => [p.id, p])), [boardProjects]);
	const projectOf = useCallback((task: Task) => projectById.get(task.projectId) ?? project, [projectById, project]);

	const columns = useMemo(() => getBoardColumns(boardProjects), [boardProjects]);
	// A task sits in a custom lane only while its own project still has that column;
	// otherwise it falls back to its status, which then counts as occupied.
	const occupiedColumns = useMemo(() => {
		const customColumnKeys = new Set<string>();
		for (const slot of columns) {
			if (slot.type === "custom") for (const member of slot.members) customColumnKeys.add(`${member.projectId}::${member.columnId}`);
		}
		const occupiedStatuses = new Set<TaskStatus>();
		for (const task of tasks) {
			if (!task.customColumnId || !customColumnKeys.has(`${task.projectId}::${task.customColumnId}`)) occupiedStatuses.add(task.status);
		}
		return getBoardColumns(boardProjects, { occupiedStatuses });
	}, [boardProjects, columns, tasks]);
	const laneOrderRef = useRef<string[]>([]);
	laneOrderRef.current = occupiedColumns.map(laneKey);

	const { actions, overlay } = useBoardActions({
		tasks,
		projects: boardProjects,
		projectOf,
		dispatch,
		navigate,
		spaceId: space?.id,
		columnOwner: space ? null : project,
		laneOrder: () => [...laneOrderRef.current],
	});

	const model = useMemo<BoardModel>(() => ({
		scope: { kind: boardRef.kind, id: boardRef.id, projectIds: boardProjects.map((p) => p.id) },
		formFactor,
		query: filter.query,
		setQuery: filter.setQuery,
		scopeTasks: tasks,
		tasks: filter.displayTasks,
		matches: filter.matches,
		columns,
		occupiedColumns,
		labels: filter.labels,
		agents,
		projects: boardProjects,
		layout: viewState.layout,
		setLayout: viewState.setLayout,
		preferences,
		actions,
	}), [boardRef, boardProjects, formFactor, filter.query, filter.setQuery, tasks, filter.displayTasks, filter.matches, columns, occupiedColumns, filter.labels, agents, viewState.layout, viewState.setLayout, preferences, actions]);

	// Draft being edited: reopens the New Task popup prefilled from the card.
	// Resolved from the live list, so it closes by itself once the draft is promoted or deleted.
	const [editDraftTaskId, setEditDraftTaskId] = useState<string | null>(null);
	const editDraftTask = editDraftTaskId ? tasks.find((task) => task.id === editDraftTaskId && task.draft === true) ?? null : null;
	// Resolved from the full board, so a filter never decides whether a requested task opens.
	const detailTask = props.detailTaskId ? tasks.find((task) => task.id === props.detailTaskId) ?? null : null;

	const launch = useCallback((task: Task, targetStatus: TaskStatus, mode?: "addAttempts") => {
		void requestTaskLaunch({ task, project: projectOf(task), targetStatus, dispatch, t, mode });
	}, [projectOf, dispatch, t]);

	const siblingMap = useMemo(() => {
		const map = new Map<string, Task[]>();
		for (const task of tasks) {
			if (!task.groupId) continue;
			const group = map.get(task.groupId);
			if (group) group.push(task);
			else map.set(task.groupId, [task]);
		}
		return map;
	}, [tasks]);

	const { lineage, knownProjects, applyChildrenFilter } = filter;
	const lineageFor = useCallback((task: Task): CardLineage | undefined => {
		const parent = lineageParent(task, lineage);
		const childCount = lineageChildren(task, lineage).length;
		if (parent === null && childCount === 0) return undefined;
		const parentNode = parent && parent !== "deleted" ? parent : null;
		const parentProject = parentNode ? knownProjects.find((p) => p.id === parentNode.projectId) : undefined;
		const shareable = parentNode && !(isStreamerOn && parentProject?.sensitive);
		return {
			parentLabel: parent === "deleted" ? "deleted" : parentNode ? parentSeqLabel(parentNode) : null,
			parentTitle: shareable && parentNode
				? (parentNode.projectId === task.projectId ? parentNode.title : `${parentProject?.name ?? ""} · ${parentNode.title}`)
				: null,
			childCount,
			onFilterByParent: parentNode ? () => applyChildrenFilter(parentNode) : null,
			onFilterByChildren: childCount > 0 ? () => applyChildrenFilter(task) : null,
		};
	}, [lineage, knownProjects, applyChildrenFilter, isStreamerOn]);

	const cardBindings = useMemo<BoardCardBindings>(() => ({
		projectOf,
		showProjectMark: !!space,
		dispatch,
		navigate,
		agents,
		bellCounts: props.bellCounts,
		bellReasons: props.bellReasons,
		taskPorts,
		taskDevServers: props.taskDevServers,
		taskResourceUsage: props.taskResourceUsage,
		activeTaskId: props.activeTaskId,
		siblingMap,
		taskPrMap: filter.taskPrMap,
		lineageFor,
		onLaunchVariants: (task, targetStatus) => launch(task, targetStatus),
		onAddAttempts: (task) => launch(task, task.status, "addAttempts"),
		onEditDraft: (task) => setEditDraftTaskId(task.id),
		onOpenUnresolvedComments: props.onOpenUnresolvedComments,
	}), [projectOf, space, dispatch, navigate, agents, props.bellCounts, props.bellReasons, taskPorts, props.taskDevServers, props.taskResourceUsage, props.activeTaskId, siblingMap, filter.taskPrMap, lineageFor, launch, props.onOpenUnresolvedComments]);

	// Written during render so a view rendering in this same pass already reads it.
	const sourceRef = useRef<BoardModelSource | null>(null);
	if (!sourceRef.current) sourceRef.current = { current: model };
	sourceRef.current.current = model;

	// `ctx.board` exists while the host is mounted. A layout effect, so the
	// provision lands before the first paint and the view never renders without it.
	const root = getBoardRoot();
	const [provided, setProvided] = useState(false);
	useLayoutEffect(() => {
		const dispose = root.provide("board", new BoardService(sourceRef.current!, BoardTaskCard));
		setProvided(true);
		return () => {
			setProvided(false);
			void dispose();
		};
	}, [root]);
	useEffect(() => {
		if (provided) root.emit("board/changed");
	}, [root, provided, model]);

	const registered = useRegisteredBoardViews();
	const offered = useMemo(
		() => registered.filter((view) => formFactor === "wide" || view.def.supportsNarrow),
		[registered, formFactor],
	);
	const active = offered.find((view) => view.def.id === viewState.viewType)
		?? offered.find((view) => view.def.id === KANBAN_VIEW_ID);
	const kanbanFallback = <BoardViewSlot ctx={root} component={KanbanView} />;

	const showSwitcher = !simplified && offered.length > 1;
	const switcher = showSwitcher && active ? (
		<BoardViewSwitcher views={offered} activeId={active.def.id} onPick={viewState.setViewType} />
	) : null;
	const options = active?.def.Options ? <BoardViewOptionsButton view={active} /> : null;

	return (
		<BoardCardBindingsContext.Provider value={cardBindings}>
			<LabelFilterBar
				labels={filter.labels}
				searchQuery={filter.query}
				onSearchChange={filter.setQuery}
				filterGroups={filter.filterGroups}
				disableGlobalFindShortcut={disableGlobalFindShortcut}
				leading={switcher}
				trailing={options}
			/>
			<LineageFilterNotice
				searchQuery={filter.query}
				lineage={filter.lineage}
				allProjects={filter.knownProjects}
				boardProjectIds={filter.boardProjectIds}
				currentProjectId={filter.lineageProjectId}
				onPickProject={filter.applyChildrenFilter}
				onOpenProject={(projectId, parent) => {
					rememberFilter(boardFilterKey(projectId), childrenFilterToken(parent, filter.knownProjects, projectId));
					navigate({ screen: "project", projectId });
				}}
			/>
			{provided && (
				<BoardViewErrorBoundary
					viewId={active?.def.id ?? KANBAN_VIEW_ID}
					fallback={() => (
						<>
							<div role="alert" className="mx-6 mt-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-xs">
								{t("boardView.crashed")}
							</div>
							{kanbanFallback}
						</>
					)}
				>
					{/* Until the built-in plugins have registered (a cold start's first
					    frames), Kanban renders as the same component type, so the hand-over
					    keeps its state and nothing flashes. */}
					{active ? <BoardViewSlot ctx={active.ctx} component={active.def.component} /> : kanbanFallback}
				</BoardViewErrorBoundary>
			)}
			{overlay}
			{editDraftTask && (
				<CreateTaskModal
					project={projectOf(editDraftTask)}
					dispatch={dispatch}
					draftTask={editDraftTask}
					onClose={() => setEditDraftTaskId(null)}
					onCreateAndRun={(task) => {
						setEditDraftTaskId(null);
						launch(task, "in-progress");
					}}
				/>
			)}
			{detailTask && (
				<TaskDetailModal
					task={detailTask}
					project={projectOf(detailTask)}
					dispatch={dispatch}
					onClose={() => props.onCloseTaskDetail?.()}
					navigate={navigate}
					onOpenTask={() => {
						const taskProject = projectOf(detailTask);
						props.onCloseTaskDetail?.();
						navigate(getTaskOpenMode() === "fullscreen"
							? { screen: "task", projectId: taskProject.id, taskId: detailTask.id }
							: { screen: "project", projectId: taskProject.id, activeTaskId: detailTask.id });
					}}
					onLaunchVariants={(task, targetStatus) => {
						props.onCloseTaskDetail?.();
						launch(task, targetStatus);
					}}
				/>
			)}
		</BoardCardBindingsContext.Provider>
	);
}

export default BoardHost;
