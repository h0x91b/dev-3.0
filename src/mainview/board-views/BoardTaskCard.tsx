import { createContext, useContext, type Dispatch } from "react";
import type { CodingAgent, DevServerSummary, PortInfo, Project, ResourceUsage, Task, TaskPRBadgeInfo, TaskStatus } from "../../shared/types";
import type { AppAction, Route } from "../state";
import type { CardLineage } from "../utils/taskLineage";
import TaskCard from "../components/TaskCard";
import type { BoardTaskCardProps } from "./board-service";

/** Everything the host knows about a card that a view never has to pass. */
export interface BoardCardBindings {
	projectOf(task: Task): Project;
	/** Name each card's project — only where several projects share the board. */
	showProjectMark: boolean;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	agents: CodingAgent[];
	bellCounts: Map<string, number>;
	bellReasons?: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
	taskDevServers: Map<string, DevServerSummary>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	activeTaskId?: string;
	siblingMap: Map<string, Task[]>;
	taskPrMap: Map<string, TaskPRBadgeInfo>;
	lineageFor(task: Task): CardLineage | undefined;
	onLaunchVariants(task: Task, targetStatus: TaskStatus): void;
	onAddAttempts(task: Task): void;
	onEditDraft(task: Task): void;
	onOpenUnresolvedComments?: (task: Task) => void;
}

export const BoardCardBindingsContext = createContext<BoardCardBindings | null>(null);

/** `ctx.board.TaskCard`: the dev3 card with the host's bindings filled in. */
export function BoardTaskCard({ task, onDragStart, isMoving = false, onSetMoving }: BoardTaskCardProps) {
	const host = useContext(BoardCardBindingsContext);
	if (!host) throw new Error("ctx.board.TaskCard rendered outside the board host");
	return (
		<TaskCard
			task={task}
			project={host.projectOf(task)}
			showProjectMark={host.showProjectMark}
			dispatch={host.dispatch}
			navigate={host.navigate}
			agents={host.agents}
			onLaunchVariants={host.onLaunchVariants}
			onAddAttempts={host.onAddAttempts}
			onDragStart={onDragStart ?? noop}
			bellCount={host.bellCounts.get(task.id) ?? 0}
			bellReasons={host.bellReasons?.get(task.id)}
			resourceUsage={host.taskResourceUsage?.get(task.id.slice(0, 8))}
			ports={host.taskPorts.get(task.id)}
			devServer={host.taskDevServers.get(task.id)}
			isActiveInSplit={task.id === host.activeTaskId}
			isMoving={isMoving}
			onSetMoving={onSetMoving}
			siblingMap={host.siblingMap}
			lineage={host.lineageFor(task)}
			prInfo={host.taskPrMap.get(task.id)}
			onOpenUnresolvedComments={host.onOpenUnresolvedComments}
			onEditDraft={host.onEditDraft}
		/>
	);
}

function noop() {}
