import { useEffect } from "react";
import type { Route } from "../state";
import { useMobile } from "./useMobile";
import { isElectrobun } from "../rpc";

const DESKTOP_VIEWPORT = "width=1280";
const MOBILE_VIEWPORT = "width=device-width, initial-scale=1.0, viewport-fit=cover";

/** Screens that require desktop-width viewport even on mobile (terminal). */
function needsDesktopViewport(route: Route): boolean {
	return route.screen === "task" || (route.screen === "project" && !!route.activeTaskId);
}

/**
 * Dynamically switches the viewport meta tag based on the current route.
 * On desktop this is a no-op (always desktop viewport).
 * On mobile: UI screens get device-width, terminal screens get 1280px.
 * In browser mode (remote access): always 1280px — the UI is not responsive,
 * so the phone scales the full desktop layout to fit the screen.
 */
export function useViewport(route: Route): void {
	const isMobile = useMobile();

	useEffect(() => {
		const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
		if (!meta) return;

		// Browser remote access: always desktop viewport — UI is not mobile-responsive
		if (!isElectrobun) {
			meta.content = DESKTOP_VIEWPORT;
			return;
		}

		if (!isMobile) {
			meta.content = DESKTOP_VIEWPORT;
			return;
		}

		meta.content = needsDesktopViewport(route) ? DESKTOP_VIEWPORT : MOBILE_VIEWPORT;
	}, [isMobile, route]);
}
