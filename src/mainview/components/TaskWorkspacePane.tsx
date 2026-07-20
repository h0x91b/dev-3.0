import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { Project, SharedArtifact, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import type { NavigationGuard } from "../navigation-guard";
import { api } from "../rpc";
import TaskTerminal from "./TaskTerminal";
import TaskDiffViewer from "./TaskDiffViewer";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import TaskArtifactViewer from "./TaskArtifactViewer";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { useT } from "../i18n";

const DEFAULT_ARTIFACT_WIDTH = 560;
const MIN_ARTIFACT_WIDTH = 360;
const MAX_ARTIFACT_RATIO = 0.8;
const ARTIFACT_WIDTH_KEY = "dev3-artifact-panel-width";

interface ArtifactResizeSession {
	pointerId: number;
	startX: number;
	startWidth: number;
	lastWidth: number;
	target: HTMLDivElement;
	previousCursor: string;
	previousUserSelect: string;
}

function initialArtifactWidth(): number {
	try {
		const value = Number(localStorage.getItem(ARTIFACT_WIDTH_KEY));
		if (Number.isFinite(value) && value >= MIN_ARTIFACT_WIDTH) return value;
	} catch { /* ignore */ }
	return DEFAULT_ARTIFACT_WIDTH;
}

interface TaskWorkspacePaneProps {
	projectId: string;
	taskId: string;
	tasks: Task[];
	projects: Project[];
	navigate: (route: Route) => void;
	dispatch: Dispatch<AppAction>;
	inlineDiffRequest: TaskInlineDiffRequest | null;
	onCloseInlineDiff: () => void;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
	artifactViewer?: { taskId: string; artifacts: SharedArtifact[]; index: number } | null;
	onCloseArtifactViewer?: () => void;
	skipCopyModeReset?: boolean;
}

function TaskWorkspacePane({
	projectId,
	taskId,
	tasks,
	projects,
	navigate,
	dispatch,
	inlineDiffRequest,
	onCloseInlineDiff,
	navigationGuardRef,
	artifactViewer,
	onCloseArtifactViewer = () => {},
	skipCopyModeReset = false,
}: TaskWorkspacePaneProps) {
	const task = tasks.find((item) => item.id === taskId);
	const project = projects.find((item) => item.id === projectId);
	const t = useT();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [artifactWidth, setArtifactWidth] = useState(initialArtifactWidth);
	const [artifactResizing, setArtifactResizing] = useState(false);
	const workspaceRef = useRef<HTMLDivElement>(null);
	const inlineDiffWasOpenRef = useRef(false);
	const artifactPanelRef = useRef<HTMLDivElement>(null);
	const resizeSessionRef = useRef<ArtifactResizeSession | null>(null);
	const showArtifact = artifactViewer?.taskId === taskId && !inlineDiffRequest;

	useEffect(() => {
		try { localStorage.setItem(ARTIFACT_WIDTH_KEY, String(Math.round(artifactWidth))); } catch { /* ignore */ }
	}, [artifactWidth]);

	const clampArtifactWidth = useCallback((width: number) => {
		const total = artifactPanelRef.current?.parentElement?.clientWidth || window.innerWidth;
		return Math.min(total * MAX_ARTIFACT_RATIO, Math.max(MIN_ARTIFACT_WIDTH, width));
	}, []);

	const finishArtifactResize = useCallback((releaseCapture: boolean) => {
		const session = resizeSessionRef.current;
		if (!session) return;
		resizeSessionRef.current = null;
		setArtifactWidth(session.lastWidth);
		setArtifactResizing(false);
		document.body.style.cursor = session.previousCursor;
		document.body.style.userSelect = session.previousUserSelect;
		if (releaseCapture && session.target.hasPointerCapture(session.pointerId)) {
			session.target.releasePointerCapture(session.pointerId);
		}
	}, []);

	const onArtifactResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const startWidth = artifactPanelRef.current?.offsetWidth ?? artifactWidth;
		event.currentTarget.setPointerCapture(event.pointerId);
		resizeSessionRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startWidth,
			lastWidth: startWidth,
			target: event.currentTarget,
			previousCursor: document.body.style.cursor,
			previousUserSelect: document.body.style.userSelect,
		};
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		setArtifactResizing(true);
	}, [artifactWidth]);

	const onArtifactResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const session = resizeSessionRef.current;
		if (!session || session.pointerId !== event.pointerId) return;
		const width = clampArtifactWidth(session.startWidth - (event.clientX - session.startX));
		session.lastWidth = width;
		if (artifactPanelRef.current) artifactPanelRef.current.style.width = `${width}px`;
	}, [clampArtifactWidth]);

	const resizeArtifactBy = useCallback((delta: number) => {
		setArtifactWidth((width) => clampArtifactWidth(width + delta));
	}, [clampArtifactWidth]);

	useEffect(() => () => {
		const session = resizeSessionRef.current;
		if (!session) return;
		document.body.style.cursor = session.previousCursor;
		document.body.style.userSelect = session.previousUserSelect;
	}, []);

	useEffect(() => {
		if (!showArtifact || isNarrow) return;
		const panel = artifactPanelRef.current;
		const container = panel?.parentElement;
		const clamp = () => {
			const total = container?.clientWidth || window.innerWidth;
			setArtifactWidth((width) => Math.min(total * MAX_ARTIFACT_RATIO, Math.max(MIN_ARTIFACT_WIDTH, width)));
		};
		clamp();
		window.addEventListener("resize", clamp);
		let observer: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined" && container) {
			observer = new ResizeObserver(clamp);
			observer.observe(container);
		}
		return () => {
			window.removeEventListener("resize", clamp);
			observer?.disconnect();
		};
	}, [isNarrow, showArtifact]);

	// A pane stuck in copy-mode at scroll position 0 is visually identical to a
	// live pane — silently swallows keystrokes until cleared. Reset on ordinary
	// terminal re-entry, but never as a side effect of the app-only fullscreen
	// remount because that would mutate user-owned tmux state.
	const terminalVisible = !inlineDiffRequest;
	useEffect(() => {
		if (!terminalVisible || skipCopyModeReset) return;
		api.request.exitCopyModeAllPanes({ taskId }).catch(() => {
			// best effort — session may not exist yet for brand-new tasks
		});
	}, [skipCopyModeReset, taskId, terminalVisible]);

	// The diff is an in-place overlay, so closing it reveals the already-mounted
	// terminal instead of remounting it. Restore DOM focus explicitly; otherwise
	// keyboard shortcuts such as Cmd+V stay on <body> and never reach ghostty.
	useEffect(() => {
		if (inlineDiffRequest) {
			inlineDiffWasOpenRef.current = true;
			return;
		}
		if (!inlineDiffWasOpenRef.current) return;
		inlineDiffWasOpenRef.current = false;
		workspaceRef.current
			?.querySelector<HTMLElement>('[data-terminal="true"]')
			?.focus({ preventScroll: true });
	}, [inlineDiffRequest]);

	return (
		<div ref={workspaceRef} className="h-full w-full relative overflow-hidden">
			{artifactResizing && (
				<div data-testid="artifact-resize-shield" aria-hidden="true" className="absolute inset-0 z-[60] cursor-col-resize" />
			)}
			<div className={inlineDiffRequest ? "h-full hidden" : "h-full flex min-w-0"}>
				{/* key={taskId} forces a fresh TaskTerminal instance per task.
				   Without it, the previous task's cached `ptyUrl` state is
				   still in scope when `taskId` changes, so TerminalView
				   first remounts with (old url + new taskId), repaints the
				   leaving task's content in the freshly re-created canvas,
				   then remounts again once the new url arrives — producing
				   the "clean of screen of the task we leave" flicker. */}
				<div className={`${showArtifact && isNarrow ? "hidden" : "flex"} min-w-0 min-h-0 flex-1 flex-col`}>
					<TaskTerminal
						key={taskId}
						projectId={projectId}
						taskId={taskId}
						tasks={tasks}
						projects={projects}
						navigate={navigate}
						dispatch={dispatch}
						hideInfoPanel
					/>
				</div>
				{showArtifact && artifactViewer && (
					<>
						{!isNarrow && (
							<div
								className={`group flex w-[7px] flex-shrink-0 touch-none cursor-col-resize items-center justify-center transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 focus-visible:outline-none ${artifactResizing ? "bg-accent/15" : ""}`}
								onPointerDown={onArtifactResizeStart}
								onPointerMove={onArtifactResizeMove}
								onPointerUp={() => finishArtifactResize(true)}
								onPointerCancel={() => finishArtifactResize(true)}
								onLostPointerCapture={() => finishArtifactResize(false)}
								onDoubleClick={() => setArtifactWidth(clampArtifactWidth(DEFAULT_ARTIFACT_WIDTH))}
								onKeyDown={(event) => {
									if (event.key === "ArrowLeft") { event.preventDefault(); resizeArtifactBy(24); }
									else if (event.key === "ArrowRight") { event.preventDefault(); resizeArtifactBy(-24); }
								}}
								role="separator"
								tabIndex={0}
								aria-orientation="vertical"
								aria-label={t("artifactViewer.resize")}
								aria-valuemin={MIN_ARTIFACT_WIDTH}
								aria-valuemax={Math.round((artifactPanelRef.current?.parentElement?.clientWidth || window.innerWidth) * MAX_ARTIFACT_RATIO)}
								aria-valuenow={Math.round(artifactWidth)}
							>
								<div
									data-testid="artifact-resize-grip"
									className={`h-8 w-[3px] rounded-full transition-colors group-hover:bg-accent group-focus-visible:bg-accent ${artifactResizing ? "bg-accent" : "bg-fg-muted/40"}`}
								/>
							</div>
						)}
						<div
							ref={artifactPanelRef}
							className="min-h-0 min-w-0 flex-shrink-0 overflow-hidden"
							style={{ width: isNarrow ? "100%" : artifactWidth }}
						>
							<TaskArtifactViewer
								taskId={taskId}
								artifacts={artifactViewer.artifacts}
								initialIndex={artifactViewer.index}
								onClose={onCloseArtifactViewer}
							/>
						</div>
					</>
				)}
			</div>

			{inlineDiffRequest && task && project && (
				<div className="absolute inset-0">
					<TaskDiffViewer
						task={task}
						project={project}
						request={inlineDiffRequest}
						onBack={onCloseInlineDiff}
						navigationGuardRef={navigationGuardRef}
					/>
				</div>
			)}
		</div>
	);
}

export default TaskWorkspacePane;
