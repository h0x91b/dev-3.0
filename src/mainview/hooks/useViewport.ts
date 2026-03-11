import { useEffect } from "react";
import type { Route } from "../state";
import { useMobile } from "./useMobile";
import { isElectrobun } from "../rpc";

const DESKTOP_VIEWPORT = "width=1280";
const BROWSER_VIEWPORT = "width=768";
const BROWSER_TERMINAL_VIEWPORT = "width=1024";
const MOBILE_VIEWPORT = "width=device-width, initial-scale=1.0, viewport-fit=cover";

/** Screens that show the terminal and need a wider viewport in browser mode. */
function isTerminalScreen(route: Route): boolean {
	return route.screen === "task" || (route.screen === "project" && !!route.activeTaskId);
}

/**
 * Dynamically switches the viewport meta tag based on the current route.
 * - Electrobun desktop: always 1280px.
 * - Electrobun mobile (hypothetical): device-width for UI, 1280 for terminal.
 * - Browser remote access: 768px for UI screens, 1024px for terminal screens.
 */
export function useViewport(route: Route): void {
	const isMobile = useMobile();

	useEffect(() => {
		const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
		if (!meta) return;

		// Browser remote access: wider viewport for terminal, compact for UI
		if (!isElectrobun) {
			meta.content = isTerminalScreen(route) ? BROWSER_TERMINAL_VIEWPORT : BROWSER_VIEWPORT;
			return;
		}

		if (!isMobile) {
			meta.content = DESKTOP_VIEWPORT;
			return;
		}

		meta.content = isTerminalScreen(route) ? DESKTOP_VIEWPORT : MOBILE_VIEWPORT;
	}, [isMobile, route]);
}
