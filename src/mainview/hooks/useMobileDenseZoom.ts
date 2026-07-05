import { useEffect } from "react";
import type { Route } from "../state";
import { retainDenseZoom } from "../zoom";

/**
 * Screens that show a task workspace (terminal / diff): the full-screen task
 * view, the standalone project terminal, and the board with an open task.
 */
export function isTerminalRoute(route: Route): boolean {
	return (
		route.screen === "task" ||
		route.screen === "project-terminal" ||
		(route.screen === "project" && (Boolean(route.activeTaskId) || Boolean(route.taskView)))
	);
}

/**
 * While a terminal/diff screen is shown, request the dense UI scale
 * (mobile-only — see MOBILE_DENSE_FACTOR in zoom.ts). Board, dashboard and
 * settings keep the regular scale; they are already mobile-adapted.
 */
export function useMobileDenseZoom(route: Route): void {
	const dense = isTerminalRoute(route);
	useEffect(() => {
		if (!dense) return;
		return retainDenseZoom();
	}, [dense]);
}
