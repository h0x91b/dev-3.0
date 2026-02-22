import type { Dispatch } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { STATUS_COLORS } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { useT } from "../i18n";
import TaskCard from "./TaskCard";

interface KanbanColumnProps {
	status: TaskStatus;
	label: string;
	tasks: Task[];
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	onAddTask: () => void;
}

function KanbanColumn({
	status,
	label,
	tasks,
	project,
	dispatch,
	navigate,
	onAddTask,
}: KanbanColumnProps) {
	const t = useT();
	const color = STATUS_COLORS[status];

	return (
		<div className="flex flex-col flex-shrink-0 w-[240px] h-full bg-raised rounded-2xl overflow-hidden border border-edge">
			{/* Column header */}
			<div
				className="px-4 py-3.5 flex-shrink-0"
				style={{ borderBottom: `2px solid ${color}30` }}
			>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2.5">
						<div
							className="w-3 h-3 rounded-full flex-shrink-0"
							style={{ background: color }}
						/>
						<span className="text-fg text-sm font-semibold">
							{label}
						</span>
					</div>
					{tasks.length > 0 && (
						<span
							className="text-xs font-bold px-2 py-0.5 rounded-full"
							style={{
								color,
								background: `${color}18`,
							}}
						>
							{tasks.length}
						</span>
					)}
				</div>
			</div>

			{/* Tasks */}
			<div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
				{tasks.map((task) => (
					<TaskCard
						key={task.id}
						task={task}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
					/>
				))}

				{tasks.length === 0 && (
					<div className="text-fg-muted text-sm text-center py-8">
						{t("kanban.noTasks")}
					</div>
				)}
			</div>

			{/* Add task button (only in To Do column) */}
			{status === "todo" && (
				<div className="px-3 pb-3 flex-shrink-0">
					<button
						onClick={onAddTask}
						className="w-full text-fg-3 hover:text-accent text-sm font-medium text-center py-2.5 rounded-xl hover:bg-accent/10 border border-dashed border-edge hover:border-accent/30 transition-all"
					>
						{t("kanban.newTask")}
					</button>
				</div>
			)}
		</div>
	);
}

export default KanbanColumn;
