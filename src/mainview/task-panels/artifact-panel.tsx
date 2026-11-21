import { useState, useSyncExternalStore } from "react";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import type { LiveArtifact, SharedArtifact, TaskStatus } from "../../shared/types";
import TaskArtifactViewer from "../components/TaskArtifactViewer";
import { requestTaskTerminalFocus } from "../terminal-focus-request";
import { closeTaskPanel, getTaskDockSeat, openTaskPanel } from "./dock-store";
import type { TaskPanelProps } from "./registry";
import { PanelCrashed } from "./TaskPanelInstances";

export const ARTIFACT_PANEL_ID = "builtin:artifact";

/**
 * The one artifact viewer the app has open. `paneless`: opened from a surface with
 * no workspace behind it (the task detail modal, a task not on screen); such a viewer
 * is a popup for its whole life, it neither docks nor hides with the route.
 */
export interface ArtifactViewerState {
	taskId: string;
	projectId?: string;
	taskStatus?: TaskStatus;
	artifacts: SharedArtifact[];
	index: number;
	paneless?: boolean;
	live?: LiveArtifact;
}

let viewer: ArtifactViewerState | null = null;
/** Bumped on every show, so a crashed viewer gets a fresh try the next time it is shown. */
let shown = 0;
let popupPreference = false;
const listeners = new Set<() => void>();

function floats(state: ArtifactViewerState): boolean {
	return state.paneless === true || popupPreference;
}

function notify(): void {
	for (const listener of listeners) listener();
}

/**
 * Keeps the viewer's panel open for its task, and only its task: one viewer app-wide.
 * Opening or republishing brings it to the front of the dock; under the popup preference,
 * or paneless, it floats instead of taking a tab.
 */
function setViewer(next: ArtifactViewerState | null): void {
	const previous = viewer;
	viewer = next;
	if (next) shown++;
	if (previous && previous.taskId !== next?.taskId) closeTaskPanel(previous.taskId, ARTIFACT_PANEL_ID);
	if (next) openTaskPanel(next.taskId, ARTIFACT_PANEL_ID, { floating: floats(next) });
	notify();
}

export function showArtifactViewer(next: ArtifactViewerState | ((previous: ArtifactViewerState | null) => ArtifactViewerState)): void {
	setViewer(typeof next === "function" ? next(viewer) : next);
}

/** Closes the viewer and hands the keyboard back: the task's terminal when it is on screen, else the badge. */
export function closeArtifactViewer(): void {
	const taskId = viewer?.taskId;
	setViewer(null);
	const focusBadge = () => document.querySelector<HTMLButtonElement>("[data-testid='shared-artifacts-badge']")?.focus();
	requestAnimationFrame(() => {
		if (taskId && getTaskDockSeat(taskId) !== undefined) requestTaskTerminalFocus(taskId, { currentPane: true });
		else focusBadge();
	});
}

export function getArtifactViewer(): ArtifactViewerState | null {
	return viewer;
}

/** Open for this task and visible somewhere, not waiting offscreen for its task to come back. */
export function isArtifactViewerShowing(taskId: string): boolean {
	if (viewer?.taskId !== taskId) return false;
	return floats(viewer) || getTaskDockSeat(taskId) !== undefined;
}

/** `openArtifactsInPopup`, mirrored from Global Settings. Flipping it re-hosts the open viewer. */
export function setArtifactPopupPreference(enabled: boolean): void {
	if (popupPreference === enabled) return;
	popupPreference = enabled;
	if (viewer) openTaskPanel(viewer.taskId, ARTIFACT_PANEL_ID, { floating: floats(viewer) });
	notify();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function resetArtifactViewerForTests(): void {
	viewer = null;
	shown = 0;
	popupPreference = false;
	notify();
}

/**
 * The dock's built-in artifact panel: the one viewer, docked in the panel's own element,
 * a popup when it floats or the task is on screen without a dock (narrow, immersive),
 * hidden while its task is off screen or another tab is in front.
 */
export function ArtifactPanel({ taskId, task, presentation }: TaskPanelProps) {
	const state = useSyncExternalStore(subscribe, getArtifactViewer);
	const [dock, setDock] = useState<HTMLDivElement | null>(null);
	if (!state || state.taskId !== taskId) return null;
	const inDock = presentation === "docked" || presentation === "inactive";
	const hidden = presentation === "inactive" || presentation === "offscreen";
	return (
		<>
			<div ref={setDock} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
			<SlotErrorBoundary slot="taskPanels" resetKey={`${ARTIFACT_PANEL_ID}#${shown}`} fallback={() => <PanelCrashed onClose={closeArtifactViewer} floating={!inDock && !hidden} />}>
				<TaskArtifactViewer
					taskId={state.taskId}
					projectId={state.projectId}
					task={task}
					taskStatus={state.taskStatus}
					live={task?.liveArtifact ?? state.live}
					artifacts={state.artifacts}
					initialIndex={state.index}
					dock={inDock ? dock : null}
					offscreen={hidden}
					onClose={closeArtifactViewer}
				/>
			</SlotErrorBoundary>
		</>
	);
}
