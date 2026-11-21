import { useEffect, useLayoutEffect, useRef } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import type { NavigationGuard } from "../navigation-guard";
import { api } from "../rpc";
import TaskTerminal from "./TaskTerminal";
import TaskDiffViewer from "./TaskDiffViewer";
import type { TaskInlineDiffRequest } from "./task-inline-diff";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import TaskDock from "../task-panels/TaskDock";
import { closeTaskPanel, openTaskPanel } from "../task-panels/dock-store";
import { ARTIFACT_PANEL_ID } from "../task-panels/builtins";
import FileExplorerFrame from "./FileExplorerFrame";
import { useYaziLauncher } from "./task-info-panel/useYaziLauncher";

interface TaskWorkspacePaneProps {
	projectId: string;
	/** The space the task was opened from; leaving a deleted task returns to that space's board. */
	spaceId?: string | null;
	taskId: string;
	tasks: Task[];
	projects: Project[];
	navigate: (route: Route) => void;
	dispatch: Dispatch<AppAction>;
	inlineDiffRequest: TaskInlineDiffRequest | null;
	onCloseInlineDiff: () => void;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
	/** An artifact of THIS task wants the docked panel (the default presentation).
	 *  The pane still refuses it while the inline diff owns the surface, and on a
	 *  narrow viewport, where the popup is the compact presentation. */
	dockArtifact?: boolean;
	skipCopyModeReset?: boolean;
	/** Immersive fullscreen: §5 keeps that surface chrome-free, so it takes no
	 *  help zone. Every other mount site is an ordinary task screen. */
	immersive?: boolean;
}

function TaskWorkspacePane({
	projectId,
	spaceId = null,
	taskId,
	tasks,
	projects,
	navigate,
	dispatch,
	inlineDiffRequest,
	onCloseInlineDiff,
	navigationGuardRef,
	dockArtifact = false,
	skipCopyModeReset = false,
	immersive = false,
}: TaskWorkspacePaneProps) {
	const task = tasks.find((item) => item.id === taskId);
	const project = projects.find((item) => item.id === projectId);
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const yazi = useYaziLauncher(task, project);
	const workspaceRef = useRef<HTMLDivElement>(null);
	const inlineDiffWasOpenRef = useRef(false);

	// The artifact viewer (still mounted by App) asks for this task's dock through
	// `dockArtifact`; its tab lives as long as the request does.
	useLayoutEffect(() => {
		if (!dockArtifact) return;
		openTaskPanel(taskId, ARTIFACT_PANEL_ID, { activate: false });
		return () => closeTaskPanel(taskId, ARTIFACT_PANEL_ID);
	}, [dockArtifact, taskId]);

	// The open task was deleted or moved away: leave its dead screen for the board. Asks the
	// server first, so a list briefly holding another project's tasks never bounces the user.
	const shownTaskRef = useRef<string | null>(null);
	useEffect(() => {
		if (task) {
			shownTaskRef.current = task.id;
			return;
		}
		if (shownTaskRef.current !== taskId) return;
		let cancelled = false;
		api.request.getTasks({ projectId }).then(
			(loaded) => {
				if (cancelled || loaded.some((item) => item.id === taskId)) return;
				shownTaskRef.current = null;
				navigate(spaceId ? { screen: "project", projectId, spaceId } : { screen: "project", projectId });
			},
			(err) => console.warn("Could not confirm the open task was deleted:", err),
		);
		return () => {
			cancelled = true;
		};
	}, [task, taskId, projectId, spaceId, navigate]);

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
		<div ref={workspaceRef} className="h-full w-full relative overflow-hidden" data-help-id={immersive ? undefined : "terminal.task"} data-tour-anchor={immersive ? undefined : "task.terminal"}>
			<div className={inlineDiffRequest ? "h-full hidden" : "h-full flex min-w-0"}>
				{/* key={taskId} forces a fresh TaskTerminal instance per task.
				   Without it, the previous task's cached `ptyUrl` state is
				   still in scope when `taskId` changes, so TerminalView
				   first remounts with (old url + new taskId), repaints the
				   leaving task's content in the freshly re-created canvas,
				   then remounts again once the new url arrives — producing
				   the "clean of screen of the task we leave" flicker. */}
				<div className="flex min-w-0 min-h-0 flex-1 flex-col">
					<FileExplorerFrame
						projectId={projectId}
						taskId={taskId}
						rootLabel={task?.branchName ?? task?.title ?? ""}
						enabled={!immersive && !isNarrow && !!task?.worktreePath}
						onOpenYazi={task ? yazi.launch : undefined}
						rootSectionLabel={task?.branchName ?? undefined}
						onEditFolders={() => navigate({ screen: "project-settings", projectId, tab: "project" })}
					>
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
					</FileExplorerFrame>
					{yazi.dialog}
				</div>
				<TaskDock taskId={taskId} covered={!!inlineDiffRequest} canDock={!isNarrow && !immersive} />
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
