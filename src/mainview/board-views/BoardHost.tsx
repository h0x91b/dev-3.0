import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch } from "react";
import type { DevServerSummary, PortInfo, Project, ResourceUsage, Space, Task } from "../../shared/types";
import { getBoardColumns } from "../../shared/types";
import { KANBAN_VIEW_ID, type BoardFormFactor, type BoardRef } from "../../shared/board-view-state";
import type { AppAction, Route } from "../state";
import { useT } from "../i18n";
import LabelFilterBar from "../components/LabelFilterBar";
import LineageFilterNotice from "../components/LineageFilterNotice";
import { CAROUSEL_MAX_WIDTH } from "../components/MobileBoardCarousel";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useAgents } from "../hooks/useAgents";
import { boardFilterKey, rememberFilter } from "../hooks/useRememberedFilter";
import { childrenFilterToken } from "../utils/taskLineage";
import { HIDDEN_CONTROLS_CHANGED_EVENT, isSimplifyViewApplied } from "../hidden-controls";
import { BoardService, type BoardModel, type BoardModelSource } from "./board-service";
import { getBoardRoot } from "./root";
import { useRegisteredBoardViews } from "./react";
import { useBoardFilter } from "./useBoardFilter";
import { useBoardViewState } from "./useBoardViewState";
import { useBoardActions } from "./useBoardActions";
import { BoardViewErrorBoundary, BoardViewOptionsButton, BoardViewSlot, BoardViewSwitcher } from "./BoardViewChrome";
import { KanbanView, LegacyKanbanBridge } from "./kanban";

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

	const projectById = useMemo(() => new Map(boardProjects.map((p) => [p.id, p])), [boardProjects]);
	const projectOf = useCallback((task: Task) => projectById.get(task.projectId) ?? project, [projectById, project]);
	const { actions, overlay } = useBoardActions({ tasks, projects: boardProjects, projectOf, dispatch, navigate, spaceId: space?.id });

	const columns = useMemo(() => getBoardColumns(boardProjects), [boardProjects]);
	const model = useMemo<BoardModel>(() => ({
		scope: { kind: boardRef.kind, id: boardRef.id, projectIds: boardProjects.map((p) => p.id) },
		formFactor,
		query: filter.query,
		setQuery: filter.setQuery,
		scopeTasks: tasks,
		tasks: filter.displayTasks,
		matches: filter.matches,
		columns,
		labels: filter.labels,
		agents,
		projects: boardProjects,
		layout: viewState.layout,
		setLayout: viewState.setLayout,
		actions,
	}), [boardRef, boardProjects, formFactor, filter.query, filter.setQuery, tasks, filter.displayTasks, filter.matches, columns, filter.labels, agents, viewState.layout, viewState.setLayout, actions]);

	// Written during render so a view rendering in this same pass already reads it.
	const sourceRef = useRef<BoardModelSource | null>(null);
	if (!sourceRef.current) sourceRef.current = { current: model };
	sourceRef.current.current = model;

	// `ctx.board` exists while the host is mounted. A layout effect, so the
	// provision lands before the first paint and the view never renders without it.
	const root = getBoardRoot();
	const [provided, setProvided] = useState(false);
	useLayoutEffect(() => {
		const dispose = root.provide("board", new BoardService(sourceRef.current!));
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

	const legacy = useMemo(() => ({
		project,
		space,
		memberProjects: props.memberProjects,
		taskPrMap: filter.taskPrMap,
		lineage: filter.lineage,
		onApplyChildrenFilter: filter.applyChildrenFilter,
		dispatch,
		navigate,
		bellCounts: props.bellCounts,
		bellReasons: props.bellReasons,
		taskPorts,
		taskDevServers: props.taskDevServers,
		taskResourceUsage: props.taskResourceUsage,
		activeTaskId: props.activeTaskId,
		onOpenUnresolvedComments: props.onOpenUnresolvedComments,
		detailTaskId: props.detailTaskId,
		onCloseTaskDetail: props.onCloseTaskDetail,
		allProjects,
	}), [project, space, props.memberProjects, filter.taskPrMap, filter.lineage, filter.applyChildrenFilter, dispatch, navigate, props.bellCounts, props.bellReasons, taskPorts, props.taskDevServers, props.taskResourceUsage, props.activeTaskId, props.onOpenUnresolvedComments, props.detailTaskId, props.onCloseTaskDetail, allProjects]);

	const showSwitcher = !simplified && offered.length > 1;
	const switcher = showSwitcher && active ? (
		<BoardViewSwitcher views={offered} activeId={active.def.id} onPick={viewState.setViewType} />
	) : null;
	const options = active?.def.Options ? <BoardViewOptionsButton view={active} /> : null;

	return (
		<LegacyKanbanBridge.Provider value={legacy}>
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
		</LegacyKanbanBridge.Provider>
	);
}

export default BoardHost;
