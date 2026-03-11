import { useEffect } from "react";
import type { Route } from "../state";
import { useMobile } from "./useMobile";
import { isElectrobun } from "../rpc";

const DESKTOP_VIEWPORT = "width=1280";
const BROWSER_VIEWPORT = "width=1024, user-scalable=no, maximum-scale=1";
const MOBILE_VIEWPORT = "width=device-width, initial-scale=1.0, viewport-fit=cover";

/** Screens that show the terminal and need a wider viewport on mobile. */
function isTerminalScreen(route: Route): boolean {
	return route.screen === "task" || (route.screen === "project" && !!route.activeTaskId);
}

/**
 * Dynamically switches the viewport meta tag based on the current route.
 * - Electrobun desktop: always 1280px.
 * - Electrobun mobile (hypothetical): device-width for UI, 1280 for terminal.
 * - Browser remote access: always 1024px (no transitions, no jumps).
 */
export function useViewport(route: Route): void {
	const isMobile = useMobile();

	useEffect(() => {
		const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
		if (!meta) return;

		// Browser remote access: fixed 1024px for all screens — no viewport jumps
		if (!isElectrobun) {
			meta.content = BROWSER_VIEWPORT;
			return;
		}

		if (!isMobile) {
			meta.content = DESKTOP_VIEWPORT;
			return;
		}

		meta.content = isTerminalScreen(route) ? DESKTOP_VIEWPORT : MOBILE_VIEWPORT;
	}, [isMobile, route]);
}
