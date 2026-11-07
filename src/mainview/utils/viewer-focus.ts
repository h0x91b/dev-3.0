import type { Route } from "../state";
import { routeShowsTaskWorkspace } from "../state";
import { requestTaskTerminalFocus } from "../terminal-focus-request";

/**
 * Hand the keyboard back after a viewer closes. Runs in a frame so the image
 * viewer's visibility:hidden on the terminal is already lifted when it focuses.
 */
export function restoreFocusAfterViewer(getRoute: () => Route, taskId: string, fallback?: () => void): void {
	requestAnimationFrame(() => {
		if (routeShowsTaskWorkspace(getRoute(), taskId)) requestTaskTerminalFocus(taskId, { currentPane: true });
		else fallback?.();
	});
}
