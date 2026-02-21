import { useEffect, useState } from "react";
import type { Task } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import TerminalView from "../TerminalView";

interface TaskTerminalProps {
	projectId: string;
	taskId: string;
	tasks: Task[];
	navigate: (route: Route) => void;
}

function TaskTerminal({ projectId, taskId, tasks, navigate }: TaskTerminalProps) {
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);
	const task = tasks.find((t) => t.id === taskId);

	useEffect(() => {
		(async () => {
			try {
				const url = await api.request.getPtyUrl({ taskId });
				setPtyUrl(url);
			} catch (err) {
				console.error("Failed to get PTY URL:", err);
			}
		})();
	}, [taskId]);

	return (
		<div className="h-screen w-screen flex flex-col bg-[#1a1b26]">
			{/* Header */}
			<div className="flex items-center gap-4 px-4 py-2 bg-[#16161e] border-b border-[#292e42]">
				<button
					onClick={() => navigate({ screen: "project", projectId })}
					className="text-[#565f89] hover:text-[#c0caf5] text-sm transition-colors"
				>
					&larr; Back to Kanban
				</button>
				{task && (
					<span className="text-[#c0caf5] text-sm font-medium truncate">
						{task.title}
					</span>
				)}
			</div>

			{/* Terminal */}
			<div className="flex-1 min-h-0">
				{ptyUrl ? (
					<TerminalView ptyUrl={ptyUrl} taskId={taskId} />
				) : (
					<div className="flex items-center justify-center h-full">
						<span className="text-[#565f89] text-sm">
							Connecting to terminal...
						</span>
					</div>
				)}
			</div>
		</div>
	);
}

export default TaskTerminal;
