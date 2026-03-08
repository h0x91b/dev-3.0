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
	hideInfoPanel?: boolean;
}

const PTY_CONNECT_TIMEOUT_MS = 10_000;

type ErrorKind = "worktree-gone" | "session-ended";

function TaskTerminal({ projectId, taskId, tasks, projects, navigate, dispatch, hideInfoPanel }: TaskTerminalProps) {
	const t = useT();
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);
	const [error, setError] = useState<{ kind: ErrorKind; path: string } | null>(null);
	const [restarting, setRestarting] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const task = tasks.find((t) => t.id === taskId);
	const project = projects.find((p) => p.id === projectId);

	async function classifyAndSetError() {
		const worktreePath = task?.worktreePath;
		if (!worktreePath) {
			setError({ kind: "worktree-gone", path: taskId });
			return;
		}
		try {
			const exists = await api.request.checkWorktreeExists({ path: worktreePath });
			setError({ kind: exists ? "session-ended" : "worktree-gone", path: worktreePath });
		} catch {
			setError({ kind: "worktree-gone", path: worktreePath });
		}
	}

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
				await classifyAndSetError();
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
				classifyAndSetError();
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

	function handleMove(newStatus: "completed" | "cancelled") {
		const fromStatus = task?.status ?? "unknown";
		if (task) {
			dispatch({ type: "updateTask", task: { ...task, status: newStatus, worktreePath: null, branchName: null, movedAt: new Date().toISOString(), columnOrder: undefined } });
		}
		dispatch({ type: "clearBell", taskId });
		trackEvent("task_moved", { from_status: fromStatus, to_status: newStatus });
		navigate({ screen: "project", projectId });
		api.request.moveTask({ taskId, projectId, newStatus, force: true }).catch((err) => {
			console.error("Background moveTask failed:", err);
		});
	}

	async function handleRestart() {
		setRestarting(true);
		try {
			const url = await api.request.getPtyUrl({ taskId, resume: true });
			setPtyUrl(url);
			setError(null);
		} catch (err) {
			console.error("[TaskTerminal] Restart failed:", err);
			await classifyAndSetError();
		} finally {
			setRestarting(false);
		}
	}

	if (error) {
		const isSessionEnded = error.kind === "session-ended";
		return (
			<div className="flex items-center justify-center h-full">
				<div className="bg-raised border border-edge rounded-lg p-6 max-w-md w-full space-y-4">
					<div className={`flex items-center gap-2 font-medium ${isSessionEnded ? "text-fg" : "text-danger"}`}>
						<span className="text-lg">{isSessionEnded ? "\u23F9" : "\u26A0"}</span>
						<span>{isSessionEnded ? t("terminal.sessionEnded") : t("terminal.envError")}</span>
					</div>
					{!isSessionEnded && (
						<div className="space-y-2">
							<p className="text-fg-2 text-sm">{t("terminal.errorPath")}</p>
							<code className="block bg-base text-fg-3 text-xs px-3 py-2 rounded border border-edge select-all break-all">
								{error.path}
							</code>
						</div>
					)}
					<p className="text-fg-3 text-sm">
						{isSessionEnded ? t("terminal.sessionEndedDesc") : t("terminal.worktreeNotFound")}
					</p>
					<div className="flex gap-3 pt-2">
						{isSessionEnded && (
							<button
								onClick={handleRestart}
								disabled={restarting}
								className="flex-1 px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
							>
								{restarting ? t("terminal.connecting") : t("terminal.resumeAgentSession")}
							</button>
						)}
						<button
							onClick={() => handleMove("completed")}
							className={`flex-1 px-4 py-2 ${isSessionEnded ? "bg-elevated text-fg-2 hover:bg-elevated-hover" : "bg-accent text-white hover:bg-accent-hover"} rounded text-sm font-medium transition-colors`}
						>
							{t("terminal.complete")}
						</button>
						<button
							onClick={() => handleMove("cancelled")}
							className="flex-1 px-4 py-2 bg-danger/10 text-danger rounded text-sm font-medium hover:bg-danger/20 transition-colors"
						>
							{t("terminal.cancelTask")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full w-full flex flex-col overflow-hidden">
			{!hideInfoPanel && task && project && <TaskInfoPanel task={task} project={project} dispatch={dispatch} navigate={navigate} />}
			<div className="flex-1 min-h-0 overflow-hidden">
				{ptyUrl ? (
					<TerminalView ptyUrl={ptyUrl} taskId={taskId} projectId={projectId} />
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
