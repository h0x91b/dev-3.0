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
}: TaskWorkspacePaneProps) {
	const task = tasks.find((item) => item.id === taskId);
	const project = projects.find((item) => item.id === projectId);
	const t = useT();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [artifactWidth, setArtifactWidth] = useState(initialArtifactWidth);
	const artifactPanelRef = useRef<HTMLDivElement>(null);
	const showArtifact = artifactViewer?.taskId === taskId && !inlineDiffRequest;

	useEffect(() => {
		try { localStorage.setItem(ARTIFACT_WIDTH_KEY, String(Math.round(artifactWidth))); } catch { /* ignore */ }
	}, [artifactWidth]);

	const onArtifactResizeStart = useCallback((event: React.MouseEvent) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = artifactPanelRef.current?.offsetWidth ?? artifactWidth;
		const panel = artifactPanelRef.current;
		function onMove(move: MouseEvent) {
			const total = panel?.parentElement?.clientWidth || window.innerWidth;
			const width = Math.min(total * MAX_ARTIFACT_RATIO, Math.max(MIN_ARTIFACT_WIDTH, startWidth - (move.clientX - startX)));
			if (panel) panel.style.width = `${width}px`;
		}
		function onUp(up: MouseEvent) {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			const total = panel?.parentElement?.clientWidth || window.innerWidth;
			setArtifactWidth(Math.min(total * MAX_ARTIFACT_RATIO, Math.max(MIN_ARTIFACT_WIDTH, startWidth - (up.clientX - startX))));
		}
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, [artifactWidth]);

	const resizeArtifactBy = useCallback((delta: number) => {
		const total = artifactPanelRef.current?.parentElement?.clientWidth || window.innerWidth;
		setArtifactWidth((width) => Math.min(total * MAX_ARTIFACT_RATIO, Math.max(MIN_ARTIFACT_WIDTH, width + delta)));
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
	// live pane — silently swallows keystrokes until cleared. Reset on every
	// re-entry into the terminal view.
	const terminalVisible = !inlineDiffRequest;
	useEffect(() => {
		if (!terminalVisible) return;
		api.request.exitCopyModeAllPanes({ taskId }).catch(() => {
			// best effort — session may not exist yet for brand-new tasks
		});
	}, [taskId, terminalVisible]);

	return (
		<div className="h-full w-full relative overflow-hidden">
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
								className="flex w-[5px] flex-shrink-0 cursor-col-resize items-center justify-center transition-colors hover:bg-accent/10"
								onMouseDown={onArtifactResizeStart}
								onDoubleClick={() => setArtifactWidth(DEFAULT_ARTIFACT_WIDTH)}
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
								<div className="h-8 w-[3px] rounded-full bg-fg-muted/40" />
							</div>
						)}
						<div
							ref={artifactPanelRef}
							className="min-h-0 min-w-0 flex-shrink-0 overflow-hidden"
							style={{ width: isNarrow ? "100%" : artifactWidth }}
						>
							<TaskArtifactViewer
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
