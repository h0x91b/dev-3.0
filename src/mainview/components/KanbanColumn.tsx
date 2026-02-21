import { useState, type Dispatch } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import TaskCard from "./TaskCard";

interface KanbanColumnProps {
	status: TaskStatus;
	label: string;
	tasks: Task[];
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function KanbanColumn({
	status,
	label,
	tasks,
	project,
	dispatch,
	navigate,
}: KanbanColumnProps) {
	const [newTitle, setNewTitle] = useState("");
	const [adding, setAdding] = useState(false);

	async function handleCreate() {
		const title = newTitle.trim();
		if (!title) return;
		try {
			const task = await api.request.createTask({
				projectId: project.id,
				title,
			});
			dispatch({ type: "addTask", task });
			setNewTitle("");
			setAdding(false);
		} catch (err) {
			alert(`Failed to create task: ${err}`);
		}
	}

	return (
		<div className="flex flex-col min-w-[180px] w-[180px] h-full bg-[#16161e] rounded-lg border border-[#292e42]">
			{/* Column header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-[#292e42]">
				<span className="text-[#a9b1d6] text-xs font-semibold uppercase tracking-wider">
					{label}
				</span>
				<span className="text-[#565f89] text-xs">{tasks.length}</span>
			</div>

			{/* Tasks */}
			<div className="flex-1 overflow-y-auto p-2 space-y-2">
				{tasks.map((task) => (
					<TaskCard
						key={task.id}
						task={task}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
					/>
				))}

				{tasks.length === 0 && !adding && (
					<div className="text-[#565f89] text-xs text-center py-4">
						Empty
					</div>
				)}
			</div>

			{/* Add task (only in To Do column) */}
			{status === "todo" && (
				<div className="p-2 border-t border-[#292e42]">
					{adding ? (
						<div className="space-y-2">
							<input
								type="text"
								value={newTitle}
								onChange={(e) => setNewTitle(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreate();
									if (e.key === "Escape") setAdding(false);
								}}
								placeholder="Task title..."
								autoFocus
								className="w-full px-2 py-1 bg-[#1a1b26] border border-[#292e42] rounded text-[#c0caf5] text-xs placeholder-[#565f89] outline-none focus:border-[#7aa2f7]"
							/>
							<div className="flex gap-1">
								<button
									onClick={handleCreate}
									className="flex-1 px-2 py-1 bg-[#7aa2f7] text-[#1a1b26] text-xs rounded hover:bg-[#89b4fa] transition-colors"
								>
									Add
								</button>
								<button
									onClick={() => setAdding(false)}
									className="px-2 py-1 text-[#565f89] text-xs hover:text-[#c0caf5] transition-colors"
								>
									Cancel
								</button>
							</div>
						</div>
					) : (
						<button
							onClick={() => setAdding(true)}
							className="w-full text-[#565f89] hover:text-[#7aa2f7] text-xs text-center py-1 transition-colors"
						>
							+ Add Task
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export default KanbanColumn;
