import { useEffect, useRef, useState, type Dispatch } from "react";
import type { Task, Project, TaskSessionState } from "../../shared/types";
import { getTaskOpenMode, taskClosedHomeRoute, type AppAction, type Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import TerminalView from "../TerminalView";
import type { TerminalHandle } from "../TerminalView";
import TaskInfoPanel from "./TaskInfoPanel";
import TaskPreparingView from "./TaskPreparingView";
import ExtraKeyBar from "./ExtraKeyBar";
import TerminalComposer from "./TerminalComposer";
import MobilePaneCarousel from "./MobilePaneCarousel";
import MobileWindowCarousel from "./MobileWindowCarousel";
import PaneZoomBadge from "./PaneZoomBadge";
import ClosePanePicker from "./ClosePanePicker";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { isElectrobun } from "../rpc";

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
	// Show ExtraKeyBar on touch devices (phones/tablets) where a physical keyboard
	// is unavailable. navigator.maxTouchPoints is more reliable than screen width
	// because the viewport meta tag overrides CSS dimensions on mobile.
	const isTouchDevice = navigator.maxTouchPoints > 0;
	// Touch input model (browser mode): compose mode is the default — the
	// terminal never summons the OSK; TerminalComposer owns text entry. The ⌨
	// toggle on ExtraKeyBar flips to raw mode (direct typing) and back.
	const touchInput = !isElectrobun && isTouchDevice;
	const [rawMode, setRawMode] = useState(false);
	// On a narrow viewport we keep the tmux window zoomed to one pane and offer a
	// pager to move between panes (instead of a cramped multi-pane split).
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	// Bumped whenever the window switcher moves to another tmux window, so the
	// pane carousel re-reads + re-zooms the newly-active window's panes at once
	// (instead of waiting up to one poll interval).
	const [windowEpoch, setWindowEpoch] = useState(0);
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);
	const [termHandle, setTermHandle] = useState<TerminalHandle | null>(null);
	const [error, setError] = useState<{ kind: ErrorKind; path: string } | null>(null);
	const [recoverable, setRecoverable] = useState<TaskSessionState | null>(null);
	const [restarting, setRestarting] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const task = tasks.find((t) => t.id === taskId);
	const project = projects.find((p) => p.id === projectId);
	const isPreparing = task?.preparing === true;

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
		// While the worktree is still being created there is no PTY to connect
		// to. Skip the request entirely and let the preparing view render; once
		// `preparing` flips false this effect re-runs and connects normally.
		if (isPreparing) return;
		let cancelled = false;
		(async () => {
			console.log("[TaskTerminal] Requesting PTY URL for task", taskId.slice(0, 8));
			try {
				const result = await api.request.getPtyUrl({ taskId });
				if (cancelled) return;
				if ("recoverable" in result) {
					console.log("[TaskTerminal] Recoverable session detected", result.sessionState);
					setRecoverable(result.sessionState);
				} else {
					console.log("[TaskTerminal] Got PTY URL:", result.url);
					setPtyUrl(result.url);
				}
			} catch (err) {
				if (cancelled) return;
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
		return () => { cancelled = true; };
	}, [taskId, isPreparing]);

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
		if (!task || !project) return;
		void moveTaskToStatus({
			task,
			project,
			newStatus,
			dispatch,
			t,
			confirm: false,
			revertOnFailure: false,
			// Land on the user's home surface: fullscreen open-mode → the board,
			// split open-mode → the split task view with nothing selected.
			afterOptimistic: () => navigate(taskClosedHomeRoute(projectId, getTaskOpenMode())),
		});
	}

	async function handleRestart() {
		setRestarting(true);
		try {
			const result = await api.request.getPtyUrl({ taskId, resume: true });
			if ("url" in result) {
				setPtyUrl(result.url);
				setError(null);
			} else if ("recoverable" in result) {
				setRecoverable(result.sessionState);
				setError(null);
			}
		} catch (err) {
			console.error("[TaskTerminal] Restart failed:", err);
			await classifyAndSetError();
		} finally {
			setRestarting(false);
		}
	}

	async function handleResumeSession() {
		setRestarting(true);
		setRecoverable(null);
		try {
			const url = await api.request.resumeTask({ taskId });
			setPtyUrl(url);
			trackEvent("session_recovered", { action: "resume" });
		} catch (err) {
			console.error("[TaskTerminal] Resume session failed:", err);
			await classifyAndSetError();
		} finally {
			setRestarting(false);
		}
	}

	async function handleStartFresh() {
		setRestarting(true);
		setRecoverable(null);
		try {
			const url = await api.request.restartTask({ taskId });
			setPtyUrl(url);
			trackEvent("session_recovered", { action: "fresh" });
		} catch (err) {
			console.error("[TaskTerminal] Start fresh failed:", err);
			await classifyAndSetError();
		} finally {
			setRestarting(false);
		}
	}

	if (isPreparing && task && project) {
		return (
			<div className="h-full w-full flex flex-col overflow-hidden">
				{!hideInfoPanel && <TaskInfoPanel task={task} project={project} dispatch={dispatch} navigate={navigate} isFullPage />}
				<div className="flex-1 min-h-0 overflow-hidden">
					<TaskPreparingView
						task={task}
						project={project}
						onCancelled={(updated) => {
							dispatch({ type: "updateTask", task: updated });
							navigate(taskClosedHomeRoute(projectId, getTaskOpenMode()));
						}}
					/>
				</div>
			</div>
		);
	}

	if (recoverable) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="bg-raised border border-edge rounded-lg p-6 max-w-md w-full space-y-4">
					<div className="flex items-center gap-2 font-medium text-fg">
						<span className="text-lg">{"\u{F0645}"}</span>
						<span>{t("terminal.recoveryTitle")}</span>
					</div>
					<p className="text-fg-3 text-sm">
						{t("terminal.recoveryDesc")}
					</p>
					<div className="space-y-3 pt-2">
						<div className="flex gap-3">
							<button
								onClick={handleResumeSession}
								disabled={restarting}
								className="flex-1 px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
							>
								{restarting ? t("terminal.connecting") : t("terminal.resumeSession")}
							</button>
							<button
								onClick={handleStartFresh}
								disabled={restarting}
								className="flex-1 px-4 py-2 bg-elevated text-fg-2 rounded text-sm font-medium hover:bg-elevated-hover transition-colors disabled:opacity-50"
							>
								{t("terminal.startFresh")}
							</button>
						</div>
						<p className="text-fg-muted text-xs">{t("terminal.startFreshDesc")}</p>
					</div>
				</div>
			</div>
		);
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

	function toggleRawMode() {
		setRawMode((prev) => {
			const next = !prev;
			// Entering raw mode inside the tap gesture opens the OSK immediately;
			// leaving it drops terminal focus so compose mode owns the keyboard.
			if (next) termHandle?.focus();
			else termHandle?.blur();
			return next;
		});
	}

	const terminalArea = ptyUrl ? (
		<TerminalView
			ptyUrl={ptyUrl}
			taskId={taskId}
			projectId={projectId}
			onReady={setTermHandle}
			touchComposeMode={touchInput && !rawMode}
		/>
	) : (
		<div className="flex items-center justify-center h-full">
			<div className="flex items-center gap-3">
				<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
				<span className="text-fg-3 text-sm">{t("terminal.connecting")}</span>
			</div>
		</div>
	);

	return (
		<div className="relative h-full w-full flex flex-col overflow-hidden">
			{!hideInfoPanel && task && project && (
				<div className="contents" data-collapse-on-compose>
					<TaskInfoPanel task={task} project={project} dispatch={dispatch} navigate={navigate} isFullPage />
				</div>
			)}
			{narrow && ptyUrl ? (
				// Narrow: a window switcher (outer) wraps the pane carousel (inner).
				// Pane swipe / dots / Arrow keys move panes; the window bar moves
				// between tmux windows (workspaces) and only renders when count > 1.
				<MobileWindowCarousel taskId={taskId} onSwitch={() => setWindowEpoch((e) => e + 1)}>
					<MobilePaneCarousel taskId={taskId} refreshKey={windowEpoch}>{terminalArea}</MobilePaneCarousel>
				</MobileWindowCarousel>
			) : (
				<div className="relative isolate flex-1 min-h-0 overflow-hidden">
					{terminalArea}
					{ptyUrl && <PaneZoomBadge taskId={taskId} />}
					{ptyUrl && <ClosePanePicker taskId={taskId} />}
				</div>
			)}
			{/* Keep the composer mounted in raw mode (hidden) so a draft survives the toggle. */}
			{touchInput && termHandle && (
				<div className={rawMode ? "hidden" : "contents"}>
					<TerminalComposer handle={termHandle} />
				</div>
			)}
			{touchInput && termHandle && <ExtraKeyBar handle={termHandle} rawMode={rawMode} onToggleRaw={toggleRawMode} />}
		</div>
	);
}

export default TaskTerminal;
