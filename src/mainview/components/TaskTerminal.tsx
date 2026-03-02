import { useEffect, useRef, useState, type Dispatch } from "react";
import type { Task, Project } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import TerminalView from "../TerminalView";
import TaskInfoPanel from "./TaskInfoPanel";

interface TaskTerminalProps {
	projectId: string;
	taskId: string;
	tasks: Task[];
	projects: Project[];
	navigate: (route: Route) => void;
	dispatch: Dispatch<AppAction>;
}

const PTY_CONNECT_TIMEOUT_MS = 10_000;

function TaskTerminal({ projectId, taskId, tasks, projects, navigate, dispatch }: TaskTerminalProps) {
	const t = useT();
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [moving, setMoving] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const task = tasks.find((t) => t.id === taskId);
	const project = projects.find((p) => p.id === projectId);

	useEffect(() => {
		(async () => {
			console.log("[TaskTerminal] Requesting PTY URL for task", taskId.slice(0, 8));
			try {
				const url = await api.request.getPtyUrl({ taskId });
				console.log("[TaskTerminal] Got PTY URL:", url);
				setPtyUrl(url);
			} catch (err) {
				console.error("[TaskTerminal] getPtyUrl FAILED:", err);
				console.error("[TaskTerminal] Error details:", {
					message: (err as Error)?.message,
					stack: (err as Error)?.stack,
					taskId,
					worktreePath: task?.worktreePath,
				});
				setError(task?.worktreePath ?? taskId);
			}
		})();
	}, [taskId]);

	// For getPtyUrl success + broken session: listen for ptyDied.
	useEffect(() => {
		function onPtyDied(e: Event) {
			const detail = (e as CustomEvent).detail;
			console.warn("[TaskTerminal] ptyDied event received", {
				eventTaskId: detail?.taskId?.slice(0, 8),
				myTaskId: taskId.slice(0, 8),
				matches: detail?.taskId === taskId,
			});
			if (detail?.taskId === taskId) {
				setError(task?.worktreePath ?? taskId);
			}
		}
		window.addEventListener("rpc:ptyDied", onPtyDied);
		return () => window.removeEventListener("rpc:ptyDied", onPtyDied);
	}, [taskId, task?.worktreePath]);

	// Fallback timeout for cases where ptyDied doesn't fire
	useEffect(() => {
		if (ptyUrl && !error) {
			timeoutRef.current = setTimeout(() => {
				// Safety net; ptyDied usually fires first.
			}, PTY_CONNECT_TIMEOUT_MS);
		}
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, [ptyUrl, error]);

	async function handleMove(newStatus: "completed" | "cancelled") {
		const fromStatus = task?.status ?? "unknown";
		setMoving(true);
		try {
			const updated = await api.request.moveTask({ taskId, projectId, newStatus, force: true });
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
			navigate({ screen: "project", projectId });
		} catch (err) {
			console.error("Failed to move task:", err);
			setMoving(false);
		}
	}

	if (error) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="bg-raised border border-edge rounded-lg p-6 max-w-md w-full space-y-4">
					<div className="flex items-center gap-2 text-danger font-medium">
						<span className="text-lg">&#9888;</span>
						<span>{t("terminal.envError")}</span>
					</div>
					<div className="space-y-2">
						<p className="text-fg-2 text-sm">{t("terminal.errorPath")}</p>
						<code className="block bg-base text-fg-3 text-xs px-3 py-2 rounded border border-edge select-all break-all">
							{error}
						</code>
					</div>
					<p className="text-fg-3 text-sm">{t("terminal.worktreeNotFound")}</p>
					<div className="flex gap-3 pt-2">
						<button
							onClick={() => handleMove("completed")}
							disabled={moving}
							className="flex-1 px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
						>
							{t("terminal.complete")}
						</button>
						<button
							onClick={() => handleMove("cancelled")}
							disabled={moving}
							className="flex-1 px-4 py-2 bg-danger/10 text-danger rounded text-sm font-medium hover:bg-danger/20 disabled:opacity-50 transition-colors"
						>
							{t("terminal.cancelTask")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full w-full flex flex-col">
			{task && project && <TaskInfoPanel task={task} project={project} dispatch={dispatch} navigate={navigate} />}
			<div className="flex-1 min-h-0 overflow-hidden p-1">
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
