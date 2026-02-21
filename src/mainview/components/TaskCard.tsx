import { useState, type Dispatch } from "react";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES, STATUS_LABELS } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";

interface TaskCardProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function TaskCard({ task, project, dispatch, navigate }: TaskCardProps) {
	const [moving, setMoving] = useState(false);

	const isActive = ACTIVE_STATUSES.includes(task.status);

	async function handleMove(newStatus: TaskStatus) {
		setMoving(true);
		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			alert(`Failed to move task: ${err}`);
		}
		setMoving(false);
	}

	async function handleDelete() {
		if (!confirm(`Delete task "${task.title}"?`)) return;
		try {
			await api.request.deleteTask({
				taskId: task.id,
				projectId: project.id,
			});
			dispatch({ type: "removeTask", taskId: task.id });
		} catch (err) {
			alert(`Failed to delete task: ${err}`);
		}
	}

	function handleClick() {
		if (isActive) {
			navigate({
				screen: "task",
				projectId: project.id,
				taskId: task.id,
			});
		}
	}

	return (
		<div
			className={`p-2 bg-[#1a1b26] border border-[#292e42] rounded text-xs ${
				isActive
					? "cursor-pointer hover:border-[#7aa2f7]"
					: ""
			} transition-colors`}
			onClick={handleClick}
		>
			<div className="text-[#c0caf5] mb-2 break-words">{task.title}</div>

			<div className="flex items-center justify-between">
				<select
					value={task.status}
					onChange={(e) => handleMove(e.target.value as TaskStatus)}
					onClick={(e) => e.stopPropagation()}
					disabled={moving}
					className="bg-[#16161e] border border-[#292e42] text-[#a9b1d6] text-[10px] rounded px-1 py-0.5 outline-none max-w-[100px]"
				>
					{ALL_STATUSES.map((s) => (
						<option key={s} value={s}>
							{STATUS_LABELS[s]}
						</option>
					))}
				</select>

				<button
					onClick={(e) => {
						e.stopPropagation();
						handleDelete();
					}}
					className="text-[#565f89] hover:text-[#f7768e] transition-colors ml-1"
					title="Delete task"
				>
					&times;
				</button>
			</div>
		</div>
	);
}

export default TaskCard;
