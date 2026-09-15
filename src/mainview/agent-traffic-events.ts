/**
 * The one window event that opens the traffic log.
 *
 * The log is App-owned (it is an overlay over any screen), while the things that
 * open it are scattered — the header readout, the keyboard shortcut, the native
 * menu and the command palette. An event keeps App from having to hand a callback
 * down through the header, which is the same pattern `menu:open-quick-shell` uses.
 */
export const OPEN_AGENT_TRAFFIC_LOG_EVENT = "open-agent-traffic-log";

/**
 * Which scope the screen opens on.
 *
 * `"current-project"` seeds the board in view — right for a deliberate entry, where
 * the user is looking at one project and asks about its traffic. `"all-projects"`
 * seeds no project at all, which is the screen's own "all active projects" default:
 * an arrival the user did not choose (a toast about a message that may belong to
 * any board) must not be filtered down to whichever board happened to be on screen.
 */
export type AgentTrafficOpenScope = "current-project" | "all-projects";

/**
 * One endpoint the screen opens with selected, exactly as a click on its card
 * would leave it: highlighted on the stage, with the inspector beside it.
 *
 * Only an arrival that is about a single task carries it (a notification click).
 * A deliberate entry has no subject and passes nothing, so the screen opens on
 * the whole scene.
 */
export interface AgentTrafficFocus {
	taskId: string;
	projectId: string;
}

export interface OpenAgentTrafficLogDetail {
	scope: AgentTrafficOpenScope;
	focus?: AgentTrafficFocus;
}

export function openAgentTrafficLog(
	scope: AgentTrafficOpenScope = "current-project",
	focus?: AgentTrafficFocus,
): void {
	window.dispatchEvent(
		new CustomEvent<OpenAgentTrafficLogDetail>(OPEN_AGENT_TRAFFIC_LOG_EVENT, { detail: { scope, focus } }),
	);
}
