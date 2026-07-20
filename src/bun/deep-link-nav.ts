// Pending deep-link navigation, for `dev3://…` opens that arrive while the app
// has NO window (it lives in the dock after the last window closed).
//
// Same pull-on-mount pattern as notification-nav: the open-url handler stores
// the resolved target and reopens a window; the freshly mounted renderer PULLS
// it via `consumePendingDeepLinkNav` (a push would race the not-yet-registered
// `rpc:openDeepLink` listener and get lost) and navigates.

import type { DeepLinkNav } from "../shared/deep-link";

let pendingNav: DeepLinkNav | null = null;

export function markPendingDeepLinkNav(target: DeepLinkNav): void {
	pendingNav = target;
}

/** Read and clear the pending target — the reopened renderer calls this on mount. */
export function consumePendingDeepLinkNav(): DeepLinkNav | null {
	const target = pendingNav;
	pendingNav = null;
	return target;
}

/** Test-only: reset between cases. */
export function __resetPendingDeepLinkNavForTests(): void {
	pendingNav = null;
}
