import type { Route } from "../state";

/** Whether the current route has a task terminal that can own immersive mode. */
export function isTaskTerminalRoute(route: Route): boolean {
	return route.screen === "task" || (route.screen === "project" && Boolean(route.activeTaskId));
}

/** Platform-aware label used by the fullscreen tooltip and shortcut reference. */
export function terminalFullscreenShortcutLabel(mac: boolean): string {
	return mac ? "F11 · ⌘⇧F" : "F11 · Ctrl+Shift+F";
}
