import type { CodingAgent, Project, Task } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import type { Route } from "../state";
import { useMemo } from "react";
import AgentLauncherBadge from "./AgentLauncherBadge";
import VariantDots from "./VariantDots";
import { getTaskAgentMeta } from "../utils/taskAgentMeta";

interface ActiveTasksStripProps {
	project: Project;
	tasks: Task[];
	activeTaskId?: string;
	navigate: (route: Route) => void;
	agents: CodingAgent[];
	bellCounts: Map<string, number>;
}

/**
 * Compact horizontal strip of active tasks — used in browser mode
 * instead of the full sidebar to save horizontal space.
 */
function ActiveTasksStrip({
	project,
	tasks,
	activeTaskId,
	navigate,
	agents,
	bellCounts,
}: ActiveTasksStripProps) {
	const statusColors = useStatusColors();
	const siblingMap = useMemo(() => {
		const map = new Map<string, Task[]>();
		for (const task of tasks) {
			if (!task.groupId) continue;
			const existing = map.get(task.groupId);
			if (existing) {
				existing.push(task);
			} else {
				map.set(task.groupId, [task]);
			}
		}
		return map;
	}, [tasks]);

	const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.includes(task.status));

	if (activeTasks.length <= 1) return null;

	function handleTaskClick(task: Task) {
		if (task.id === activeTaskId) {
			navigate({ screen: "project", projectId: project.id });
		} else {
			navigate({
				screen: "project",
				projectId: project.id,
				activeTaskId: task.id,
			});
		}
	}

	return (
		<div className="flex-shrink-0 flex items-center gap-1 px-2 py-1 border-b border-edge bg-base overflow-x-auto">
			{activeTasks.map((task) => {
				const isActive = task.id === activeTaskId;
				const bellCount = bellCounts.get(task.id) ?? 0;
				const title = getTaskTitle(task);
				const { agent, configLabel } = getTaskAgentMeta(task, agents);
				const groupMembers = task.groupId ? siblingMap.get(task.groupId) ?? [task] : [task];
				const summary = [agent?.name, configLabel].filter(Boolean).join(" · ");

				return (
					<button
						key={task.id}
						onClick={() => handleTaskClick(task)}
						className={`flex-shrink-0 flex items-center gap-1.5 px-2 py-1 rounded text-[0.625rem] leading-tight max-w-[220px] transition-colors ${
							isActive
								? "bg-accent/15 text-accent"
								: "text-fg-2 hover:bg-elevated-hover"
						}`}
					>
						{agent ? (
							<AgentLauncherBadge agent={agent} size={14} />
						) : (
							<div
								className="w-1.5 h-1.5 rounded-full flex-shrink-0"
								style={{ background: statusColors[task.status] }}
							/>
						)}
						<span className="truncate" title={summary || title}>
							{summary || `#${task.seq} ${title}`}
						</span>
						{task.variantIndex !== null && (
							<VariantDots
								groupMembers={groupMembers}
								currentTaskId={task.id}
								statusColors={statusColors}
								testId={`variant-indicator-${task.id}`}
							/>
						)}
						{bellCount > 0 && (
							<span className="flex-shrink-0 min-w-[0.875rem] h-3.5 flex items-center justify-center px-0.5 rounded-full bg-red-500 text-white text-[0.5rem] font-bold leading-none">
								{bellCount > 9 ? "9+" : bellCount}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}

export default ActiveTasksStrip;
