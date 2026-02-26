import { useEffect, useState } from "react";
import type { Task, Project } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import TerminalView from "../TerminalView";
import TaskInfoPanel from "./TaskInfoPanel";

interface TaskTerminalProps {
	projectId: string;
	taskId: string;
	tasks: Task[];
	projects: Project[];
	navigate: (route: Route) => void;
}

function TaskTerminal({ projectId, taskId, tasks, projects }: TaskTerminalProps) {
	const t = useT();
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);

	const task = tasks.find((t) => t.id === taskId);
	const project = projects.find((p) => p.id === projectId);

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
		<div className="h-full w-full flex flex-col">
			{task && project && <TaskInfoPanel task={task} project={project} />}
			<div className="flex-1 min-h-0">
				{ptyUrl ? (
					<TerminalView ptyUrl={ptyUrl} taskId={taskId} />
				) : (
					<div className="flex items-center justify-center h-full">
						<div className="flex items-center gap-3">
							<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
							<span className="text-fg-3 text-sm">{t("terminal.connecting")}</span>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export default TaskTerminal;
