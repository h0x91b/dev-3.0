import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode } from "react";
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
import TerminalComposer, { type TerminalComposerApi } from "./TerminalComposer";
import MobilePaneCarousel from "./MobilePaneCarousel";
import MobileWindowCarousel from "./MobileWindowCarousel";
import PaneZoomBadge from "./PaneZoomBadge";
import ClosePanePicker from "./ClosePanePicker";
import NativeViewerBar from "./NativeViewerBar";
import {
	mergeViewerStatus,
	type NativeStreamRole,
	type NativeViewerStatus,
	type ViewerSnapshot,
} from "../../shared/native-terminal-stream";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { isElectrobun } from "../rpc";
import type { TaskPaneState } from "../../shared/task-panes";
import { getPaneRects, restoreSplitTree, serializeSplitTree, setSplitRatio } from "../../shared/split-tree";
import NativePaneDividers from "./NativePaneDividers";
import { publishNativePaneFocus } from "../native-pane-focus";
import { fetchPaneState, runPaneAction, subscribePaneState } from "../pane-state-bus";

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
const NATIVE_PANE_POLL_MS = 2500;

type ErrorKind = "worktree-gone" | "session-ended";

function TaskTerminal({ projectId, taskId, tasks, projects, navigate, dispatch, hideInfoPanel }: TaskTerminalProps) {
	const t = useT();
	const isTouchDevice = navigator.maxTouchPoints > 0;
	const touchInput = !isElectrobun && isTouchDevice;
	const [rawMode, setRawMode] = useState(false);
	const composerApiRef = useRef<TerminalComposerApi | null>(null);
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [windowEpoch, setWindowEpoch] = useState(0);

	const task = tasks.find((t) => t.id === taskId);
	const project = projects.find((p) => p.id === projectId);
	const isPreparing = task?.preparing === true;

	// Detect native backend from the task record (available before state loads).
	const isNative = task?.terminalBackend === "native";

	// ── Tmux path state (unchanged) ────────────────────────────────────────────
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);
	const [nativeRole, setNativeRole] = useState<NativeStreamRole>("writer");
	const [refusedAt, setRefusedAt] = useState(0);
	const [refusedReason, setRefusedReason] = useState<NativeViewerStatus["refusedReason"]>(undefined);
	const [writerAttached, setWriterAttached] = useState<boolean | undefined>(undefined);
	const handleNativeStatus = useCallback((status: NativeViewerStatus) => {
		const snapshot = mergeViewerStatus(null, status);
		setNativeRole(snapshot.role);
		setWriterAttached(snapshot.writerAttached);
		setRefusedAt(snapshot.refusedAt);
		setRefusedReason(snapshot.refusedReason);
	}, []);
	const [termHandle, setTermHandle] = useState<TerminalHandle | null>(null);
	const [error, setError] = useState<{ kind: ErrorKind; path: string } | null>(null);
	const [recoverable, setRecoverable] = useState<TaskSessionState | null>(null);
	// The recovery offer came from hibernation, not from a session that died on
	// its own: same two buttons, different wording, and waking is the explicit
	// act that clears the flag.
	const [hibernated, setHibernated] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// ── Native multi-pane state ─────────────────────────────────────────────────
	const [nativePaneState, setNativePaneState] = useState<TaskPaneState | null>(null);
	const [paneUrls, setPaneUrls] = useState<Map<string, string>>(() => new Map());
	// Panes whose host this viewer could not attach to. Kept next to `alive` so a
	// lost socket and a dead pane render the SAME recovery block in every viewer,
	// instead of one window showing live output and another an unknown-session line.
	const [gonePaneIds, setGonePaneIds] = useState<Set<string>>(() => new Set());
	// Client-local focus: clicking/typing into a pane focuses it here, not on the server.
	const [clientFocusPaneId, setClientFocusPaneId] = useState<string | null>(null);
	// Per-pane handles and roles for NativeViewerBar.
	const paneHandlesRef = useRef<Map<string, TerminalHandle>>(new Map());
	// Every MOUNTED pane's full snapshot, not just the focused one: a pane keeps producing
	// role/writerAttached frames while another pane has focus, and recording only the
	// focused one made a focus switch restore defaults or stale state.
	const paneRolesRef = useRef<Map<string, ViewerSnapshot>>(new Map());
	const [focusedPaneRole, setFocusedPaneRole] = useState<NativeStreamRole>("writer");
	const [focusedPaneRefusedAt, setFocusedPaneRefusedAt] = useState(0);
	const [focusedPaneRefusedReason, setFocusedPaneRefusedReason] = useState<NativeViewerStatus["refusedReason"]>(undefined);
	/** Whether ANY process holds the lease; undefined until the host reports it. */
	const [focusedPaneWriterAttached, setFocusedPaneWriterAttached] = useState<boolean | undefined>(undefined);

	// A host that is gone never comes back, so a pane stays marked until it leaves
	// the pane set — re-asking every poll would just hammer a dead session.
	function markPaneGone(paneId: string) {
		setGonePaneIds((prev) => (prev.has(paneId) ? prev : new Set(prev).add(paneId)));
	}

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

	// ── Tmux PTY URL effect (skipped for native) ──────────────────────────────
	useEffect(() => {
		if (isNative) return;
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
					setHibernated(result.hibernated === true);
				} else {
					console.log("[TaskTerminal] Got PTY URL:", result.url);
					setPtyUrl(result.url);
				}
			} catch (err) {
				if (cancelled) return;
				console.error("[TaskTerminal] getPtyUrl FAILED:", err);
				await classifyAndSetError();
			}
		})();
		return () => { cancelled = true; };
	}, [taskId, isPreparing, isNative]);

	// ── Native pane state ──────────────────────────────────────────────────────
	// Every arrival — this poll, the inspector toolbar's poll, or any pane action's
	// own response — comes through the bus, so a toolbar click repaints the canvas
	// as soon as the server answers instead of on the next poll tick.
	useEffect(() => {
		if (!isNative || isPreparing) return;
		return subscribePaneState(taskId, (state) => {
			setNativePaneState(state);
			// Forget panes the coordinator has since reconciled away.
			setGonePaneIds((prev) => {
				if (prev.size === 0) return prev;
				const live = new Set(state.panes.map((p) => p.paneId));
				const next = new Set([...prev].filter((id) => live.has(id)));
				return next.size === prev.size ? prev : next;
			});
			// Client focus is ours to keep correct: the server never corrects it
			// (decision 179), so a focused pane that left the set — a dev-server pane
			// closing is the usual way — has to hand focus to a pane that is still here.
			const live = new Set(state.panes.map((p) => p.paneId));
			setPaneUrls((prev) => {
				const stale = [...prev.keys()].filter((paneId) => !live.has(paneId));
				if (stale.length === 0) return prev;
				const next = new Map(prev);
				for (const paneId of stale) next.delete(paneId);
				return next;
			});
			setClientFocusPaneId((prev) => {
				const kept = prev && live.has(prev) ? prev : null;
				const next = kept ?? state.activePaneId ?? (state.panes[0]?.paneId ?? null);
				if (next) publishNativePaneFocus(taskId, next);
				return next;
			});
		});
	}, [taskId, isPreparing, isNative]);

	// Reconciliation only: the server owns the tree, and a failed read is how this
	// view learns the session died.
	useEffect(() => {
		if (!isNative || isPreparing) return;
		let cancelled = false;
		const fetch = async () => {
			try {
				await fetchPaneState(taskId);
			} catch {
				if (!cancelled) await classifyAndSetError();
			}
		};
		void fetch();
		const timer = setInterval(() => { void fetch(); }, NATIVE_PANE_POLL_MS);
		return () => { cancelled = true; clearInterval(timer); };
	}, [taskId, isPreparing, isNative]);

	// ── Fetch per-pane URLs when new panes appear ─────────────────────────────
	useEffect(() => {
		if (!nativePaneState) return;
		for (const pane of nativePaneState.panes) {
			if (!paneUrls.has(pane.paneId)) {
				api.request.getPanePtyUrl({ taskId, paneId: pane.paneId })
					.then((result) => {
						if ("gone" in result) {
							markPaneGone(pane.paneId);
							return;
						}
						setPaneUrls((prev) => {
							if (prev.has(pane.paneId)) return prev; // already added
							const next = new Map(prev);
							next.set(pane.paneId, result.url);
							return next;
						});
					})
					.catch(() => markPaneGone(pane.paneId));
			}
		}
	}, [nativePaneState?.panes.map((p) => p.paneId).join(",")]);

	// Hibernating a task whose terminal is already open must not leave a dead
	// socket reconnecting forever: drop straight to the wake screen the moment the
	// flag flips. Waking clears the flag, so this never fights the resume path.
	useEffect(() => {
		if (!task?.hibernated) return;
		setPtyUrl(null);
		setError(null);
		setRecoverable(task.sessionState ?? { panes: [] });
		setHibernated(true);
	}, [task?.hibernated, task?.sessionState]);

	// For getPtyUrl success + broken session: listen for ptyDied.
	useEffect(() => {
		function onPtyDied(e: Event) {
			const detail = (e as CustomEvent).detail;
			if (detail?.taskId === taskId) {
				void classifyAndSetError();
			}
		}
		window.addEventListener("rpc:ptyDied", onPtyDied);
		return () => window.removeEventListener("rpc:ptyDied", onPtyDied);
	}, [taskId, task?.worktreePath]);

	// Fallback timeout for cases where ptyDied doesn't fire
	useEffect(() => {
		if (ptyUrl && !error) {
			timeoutRef.current = setTimeout(() => {}, PTY_CONNECT_TIMEOUT_MS);
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
				setHibernated(result.hibernated === true);
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
		setHibernated(false);
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
		setHibernated(false);
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
		// A hibernated task with no stored panes has no conversation to resume —
		// only the plain-shell button is honest there.
		const canResume = !hibernated || recoverable.panes.length > 0;
		return (
			<div className="flex items-center justify-center h-full">
				<div
					data-testid={hibernated ? "terminal-wake-screen" : "terminal-recovery-screen"}
					className="bg-raised border border-edge rounded-lg p-6 max-w-md w-full space-y-4"
				>
					<div className="flex items-center gap-2 font-medium text-fg">
						<span className="text-lg">{"\u{F0645}"}</span>
						<span>{hibernated ? t("terminal.hibernatedTitle") : t("terminal.recoveryTitle")}</span>
					</div>
					<p className="text-fg-3 text-sm">
						{hibernated ? t("terminal.hibernatedDesc") : t("terminal.recoveryDesc")}
					</p>
					<div className="space-y-3 pt-2">
						<div className="flex gap-3">
							{canResume && (
								<button
									onClick={handleResumeSession}
									disabled={restarting}
									className="flex-1 px-4 py-2 bg-accent-fill text-white rounded text-sm font-medium hover:bg-accent-fill-hover transition-colors disabled:opacity-50"
								>
									{restarting ? t("terminal.connecting") : hibernated ? t("terminal.wakeResume") : t("terminal.resumeSession")}
								</button>
							)}
							<button
								onClick={handleStartFresh}
								disabled={restarting}
								className="flex-1 px-4 py-2 bg-elevated text-fg-2 rounded text-sm font-medium hover:bg-elevated-hover transition-colors disabled:opacity-50"
							>
								{hibernated ? t("terminal.wakeShell") : t("terminal.startFresh")}
							</button>
						</div>
						<p className="text-fg-muted text-xs">{hibernated ? t("terminal.wakeShellDesc") : t("terminal.startFreshDesc")}</p>
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
						<span className="text-lg">{isSessionEnded ? "⏹" : "⚠"}</span>
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
								className="flex-1 px-4 py-2 bg-accent-fill text-white rounded text-sm font-medium hover:bg-accent-fill-hover transition-colors disabled:opacity-50"
							>
								{restarting ? t("terminal.connecting") : t("terminal.resumeAgentSession")}
							</button>
						)}
						<button
							onClick={() => handleMove("completed")}
							className={`flex-1 px-4 py-2 ${isSessionEnded ? "bg-elevated text-fg-2 hover:bg-elevated-hover" : "bg-accent-fill text-white hover:bg-accent-fill-hover"} rounded text-sm font-medium transition-colors`}
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
			if (next) termHandle?.focus();
			else termHandle?.blur();
			return next;
		});
	}

	function handleAttachPaths(paths: string[]) {
		const escaped = paths.map((p) => p.replace(/ /g, "\\ "));
		if (!rawMode && composerApiRef.current) composerApiRef.current.appendPaths(escaped);
		else termHandle?.paste(`${escaped.join(" ")} `);
	}

	// ── Native multi-pane rendering ─────────────────────────────────────────────
	if (isNative) {
		// Build pane rects from the split tree for absolute positioning.
		const parsedTree = nativePaneState?.layout ? restoreSplitTree(nativePaneState.layout) : null;
		const rects = parsedTree ? getPaneRects(parsedTree) : new Map();
		const panes = nativePaneState?.panes ?? [];

		// Focused pane: clicking a pane updates client-local focus.
		const focusPaneId = clientFocusPaneId ?? nativePaneState?.activePaneId ?? panes[0]?.paneId ?? null;

		function makePaneNativeStatusHandler(paneId: string) {
			return (status: NativeViewerStatus) => {
				// Recorded for EVERY mounted pane. Focus decides what is displayed, never
				// whether ownership truth is written down.
				const snapshot = mergeViewerStatus(paneRolesRef.current.get(paneId) ?? null, status);
				paneRolesRef.current.set(paneId, snapshot);
				if (paneId !== focusPaneId) return;
				// One atomic replacement, so a non-refused authoritative frame clears the
				// diagnosis instead of leaving stale guidance on screen.
				setFocusedPaneRole(snapshot.role);
				setFocusedPaneWriterAttached(snapshot.writerAttached);
				setFocusedPaneRefusedAt(snapshot.refusedAt);
				setFocusedPaneRefusedReason(snapshot.refusedReason);
			};
		}

		function handleFocusPane(paneId: string) {
			setClientFocusPaneId(paneId);
			publishNativePaneFocus(taskId, paneId);
			// Restored from the pane's own recorded snapshot — no extra frame required.
			const stored = paneRolesRef.current.get(paneId);
			setFocusedPaneRole(stored?.role ?? "writer");
			setFocusedPaneRefusedAt(stored?.refusedAt ?? 0);
			setFocusedPaneRefusedReason(stored?.refusedReason);
			setFocusedPaneWriterAttached(stored?.writerAttached);
		}

		// A drag commits once, on release. Paint the new ratio locally first so the
		// panes do not sit at the old size until the round-trip lands; the server's
		// reply (which owns the persisted tree) then replaces it.
		function handleCommitRatio(splitId: string, ratio: number) {
			if (parsedTree) {
				const optimistic = setSplitRatio(parsedTree, splitId, ratio);
				if (optimistic !== parsedTree) {
					setNativePaneState((prev) => (prev ? { ...prev, layout: serializeSplitTree(optimistic) } : prev));
				}
			}
			void runPaneAction(taskId, { kind: "setSplitRatio", splitId, ratio }).catch(() => {});
		}

		function closeFocusedPane(paneId: string) {
			void runPaneAction(taskId, { kind: "close", paneId }).catch(() => {});
		}

		function renderNativePane(paneId: string): ReactNode {
			const url = paneUrls.get(paneId);
			const paneInfo = panes.find((p) => p.paneId === paneId);
			const isFocused = paneId === focusPaneId;

			// Pane whose host is gone: show a danger-toned recovery line. Reached both
			// when the coordinator reports it dead and when this viewer could not
			// attach, so every viewer lands on the same state rather than one of them
			// staring at a live-looking canvas.
			if (paneInfo && (paneInfo.alive === false || gonePaneIds.has(paneId))) {
				const paneIndex = (paneInfo.index ?? 0) + 1;
				return (
					<div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-raised">
						<span className="text-danger text-sm font-medium">{t("panes.exited")}</span>
						<button
							onClick={() => closeFocusedPane(paneId)}
							className="px-3 py-1.5 rounded text-xs font-medium bg-danger/10 text-danger border border-danger/25 hover:bg-danger/20 transition-colors"
							aria-label={t("panes.exitedClose") + ` (${t("panes.paneLabel", { index: String(paneIndex) })})`}
						>
							{t("panes.exitedClose")}
						</button>
					</div>
				);
			}

			return (
				<div className="h-full w-full flex flex-col overflow-hidden">
					{url ? (
						<TerminalView
							ptyUrl={url}
							taskId={taskId}
							projectId={projectId}
							onReady={(handle) => {
								paneHandlesRef.current.set(paneId, handle);
								// Use focused pane's handle for touch composer.
								if (isFocused) setTermHandle(handle);
							}}
							onNativeStatus={makePaneNativeStatusHandler(paneId)}
							onSessionLost={() => markPaneGone(paneId)}
							touchComposeMode={touchInput && !rawMode}
						/>
					) : (
						<div className="flex items-center justify-center h-full">
							<div className="flex items-center gap-3">
								<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
								<span className="text-fg-3 text-sm">{t("terminal.connecting")}</span>
							</div>
						</div>
					)}
				</div>
			);
		}

		const focusedPaneHandle = paneHandlesRef.current.get(focusPaneId ?? "");

		// Narrow: use MobilePaneCarousel (backend-neutral); MobileWindowCarousel not rendered.
		if (narrow) {
			const activePaneUrl = focusPaneId ? paneUrls.get(focusPaneId) : undefined;
			const nativeTerminalArea = activePaneUrl ? (
				<TerminalView
					key={focusPaneId}
					ptyUrl={activePaneUrl}
					taskId={taskId}
					projectId={projectId}
					onReady={(handle) => {
						if (focusPaneId) paneHandlesRef.current.set(focusPaneId, handle);
						setTermHandle(handle);
					}}
					onNativeStatus={focusPaneId ? makePaneNativeStatusHandler(focusPaneId) : undefined}
					onSessionLost={focusPaneId ? () => markPaneGone(focusPaneId) : undefined}
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
					{activePaneUrl && focusPaneId && (
						<NativeViewerBar
							role={focusedPaneRole}
							refusedAt={focusedPaneRefusedAt}
							refusedReason={focusedPaneRefusedReason}
							writerAttached={focusedPaneWriterAttached}
							onTakeControl={() => paneHandlesRef.current.get(focusPaneId)?.claimWriter()}
						/>
					)}
					<MobilePaneCarousel taskId={taskId}>{nativeTerminalArea}</MobilePaneCarousel>
					{touchInput && focusedPaneHandle && (
						<div className={rawMode ? "hidden" : "contents"}>
							<TerminalComposer handle={focusedPaneHandle} task={task} project={project} dispatch={dispatch} apiRef={composerApiRef} />
						</div>
					)}
					{touchInput && focusedPaneHandle && (
						<ExtraKeyBar
							handle={focusedPaneHandle}
							rawMode={rawMode}
							onToggleRaw={toggleRawMode}
							attachProjectId={projectId}
							attachTaskId={taskId}
							onAttachPaths={handleAttachPaths}
						/>
					)}
				</div>
			);
		}

		// Wide: absolute-positioned panes from SplitTree rects — stable keys, no remounting on sibling changes.
		const GAP = 0.003; // ~1px visual gap between panes

		// Zoom lives in the shared tree so the toolbar button, the keyboard path and a
		// reconnecting viewer all agree on which pane is zoomed.
		const zoomedPane = panes.length > 1 ? nativePaneState?.zoomedPaneId ?? null : null;

		return (
			<div className="relative h-full w-full flex flex-col overflow-hidden">
				{!hideInfoPanel && task && project && (
					<div className="contents" data-collapse-on-compose>
						<TaskInfoPanel task={task} project={project} dispatch={dispatch} navigate={navigate} isFullPage />
					</div>
				)}
				{focusPaneId && paneUrls.has(focusPaneId) && (
					<NativeViewerBar
						role={focusedPaneRole}
						refusedAt={focusedPaneRefusedAt}
							refusedReason={focusedPaneRefusedReason}
						writerAttached={focusedPaneWriterAttached}
						onTakeControl={() => paneHandlesRef.current.get(focusPaneId)?.claimWriter()}
					/>
				)}
				{zoomedPane ? (
					// Zoom mode: render only the focused pane.
					<div className="relative isolate flex-1 min-h-0 overflow-hidden">
						<div
							key={zoomedPane}
							data-pane-id={zoomedPane}
							data-zoomed="true"
							className="absolute inset-0 border border-accent/60 ring-1 ring-accent/30 overflow-hidden"
							onClick={() => handleFocusPane(zoomedPane)}
						>
							{renderNativePane(zoomedPane)}
						</div>
						<button
							className="absolute top-2 right-2 z-10 px-2 py-1 rounded text-[0.625rem] font-medium bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 transition-colors"
							onClick={() => {
								runPaneAction(taskId, { kind: "zoom", mode: "off" })
									.then(setNativePaneState)
									.catch(() => {});
							}}
							aria-label={t("panes.unzoom")}
						>
							{t("panes.unzoom")}
						</button>
					</div>
				) : panes.length > 0 ? (
					// Tiled mode: render all panes by rect.
					<div className="relative isolate flex-1 min-h-0 overflow-hidden">
						{panes.map((pane) => {
							const rect = rects.get(pane.paneId) ?? { x: 0, y: 0, width: 1, height: 1 };
							const isFocused = pane.paneId === focusPaneId;
							return (
								<div
									key={pane.paneId}
									data-pane-id={pane.paneId}
									data-focused={isFocused ? "true" : "false"}
									className={`absolute overflow-hidden border ${
										isFocused ? "border-accent/60 ring-1 ring-accent/30" : "border-edge"
									}`}
									style={{
										left: `${(rect.x + GAP / 2) * 100}%`,
										top: `${(rect.y + GAP / 2) * 100}%`,
										width: `${Math.max(0, rect.width - GAP) * 100}%`,
										height: `${Math.max(0, rect.height - GAP) * 100}%`,
									}}
									onClick={() => handleFocusPane(pane.paneId)}
								>
									{renderNativePane(pane.paneId)}
								</div>
							);
						})}
						{parsedTree && panes.length > 1 && (
							<NativePaneDividers
								tree={parsedTree}
								paneIndexById={new Map(panes.map((p) => [p.paneId, (p.index ?? 0) + 1]))}
								onCommitRatio={handleCommitRatio}
							/>
						)}
						<ClosePanePicker taskId={taskId} />
					</div>
				) : (
					// No panes yet (loading).
					<div className="flex items-center justify-center flex-1">
						<div className="flex items-center gap-3">
							<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
							<span className="text-fg-3 text-sm">{t("terminal.connecting")}</span>
						</div>
					</div>
				)}
				{touchInput && focusedPaneHandle && (
					<div className={rawMode ? "hidden" : "contents"}>
						<TerminalComposer handle={focusedPaneHandle} task={task} project={project} dispatch={dispatch} apiRef={composerApiRef} />
					</div>
				)}
				{touchInput && focusedPaneHandle && (
					<ExtraKeyBar
						handle={focusedPaneHandle}
						rawMode={rawMode}
						onToggleRaw={toggleRawMode}
						attachProjectId={projectId}
						attachTaskId={taskId}
						onAttachPaths={handleAttachPaths}
					/>
				)}
			</div>
		);
	}

	// ── Tmux path (unchanged) ──────────────────────────────────────────────────

	const terminalArea = ptyUrl ? (
		<TerminalView
			ptyUrl={ptyUrl}
			taskId={taskId}
			projectId={projectId}
			onReady={setTermHandle}
			onNativeStatus={handleNativeStatus}
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
			{ptyUrl && (
				<NativeViewerBar
					role={nativeRole}
					refusedAt={refusedAt}
					refusedReason={refusedReason}
					writerAttached={writerAttached}
					onTakeControl={() => termHandle?.claimWriter()}
				/>
			)}
			{narrow && ptyUrl ? (
				// Narrow: a window switcher (outer) wraps the pane carousel (inner).
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
			{touchInput && termHandle && (
				<div className={rawMode ? "hidden" : "contents"}>
					<TerminalComposer handle={termHandle} task={task} project={project} dispatch={dispatch} apiRef={composerApiRef} />
				</div>
			)}
			{touchInput && termHandle && (
				<ExtraKeyBar
					handle={termHandle}
					rawMode={rawMode}
					onToggleRaw={toggleRawMode}
					attachProjectId={projectId}
					attachTaskId={taskId}
					onAttachPaths={handleAttachPaths}
				/>
			)}
		</div>
	);
}

export default TaskTerminal;
