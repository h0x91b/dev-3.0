/**
 * The one window event that opens the traffic log.
 *
 * The log is App-owned (it is an overlay over any screen), while the things that
 * open it are scattered — the header readout, the keyboard shortcut, the native
 * menu and the command palette. An event keeps App from having to hand a callback
 * down through the header, which is the same pattern `menu:open-quick-shell` uses.
 */
export const OPEN_AGENT_TRAFFIC_LOG_EVENT = "open-agent-traffic-log";

export function openAgentTrafficLog(): void {
	window.dispatchEvent(new CustomEvent(OPEN_AGENT_TRAFFIC_LOG_EVENT));
}
