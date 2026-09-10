/**
 * The archived `dev3 notify` history, as timeline-ready events.
 *
 * Thin on purpose: the read, the debounce and the cache live in the store
 * (`mainview/notification-traffic.ts`), the three rules about a notification live
 * in the normalizer (`mainview/notification-event.ts`). This hook only decides
 * WHEN to read, WHICH projects the read may touch, and whether the answer has
 * arrived yet.
 */

import { useEffect, useMemo, useState } from "react";
import {
	getNotificationTrafficState,
	loadNotificationTraffic,
	noteNotificationArrival,
	subscribeNotificationTraffic,
} from "../../notification-traffic";
import { notificationEvents, type TrafficNotificationEvent } from "../../notification-event";
import { useProjectPrivacy } from "../../sensitive-projects";

/**
 * Whether the archive has answered.
 *
 * `idle` and `loading` are deliberately different: a one-shot latch that waits
 * for "not loading" would fire before the first read has even been asked for.
 * Only `ready` and `failed` mean the answer is in — and `failed` is one of them,
 * because a transport failure must not park a caller forever.
 */
export type NotificationTrafficStatus = "idle" | "loading" | "ready" | "failed";

/**
 * Deliberately two fields.
 *
 * The page also carries `oldestDay` / `newestDay` / `retentionDays` / `hasMore`,
 * and this hook used to pass all four through with nothing reading them. They are
 * not exposed until a surface asks: a getter nobody calls reads as a promise the
 * screen makes ("you can page this archive") that no code keeps. The store keeps
 * them, so adding one back is one line.
 */
export interface NotificationTrafficView {
	/** Oldest first, matching the timeline's reading order. */
	events: TrafficNotificationEvent[];
	status: NotificationTrafficStatus;
}

function statusOf(state: {
	loading: boolean;
	loaded: boolean;
	error?: boolean;
}): NotificationTrafficStatus {
	if (state.error) return "failed";
	if (state.loading) return "loading";
	return state.loaded ? "ready" : "idle";
}

/**
 * Read the archive for `projectIds`, or read nothing at all while they are still
 * unknown.
 *
 * `null` means "the visible projects have not been established yet" and is NOT
 * the same as `[]`. Reading unscoped in that moment would put a sensitive
 * project's notification text on the wire before anyone could stop it, so the
 * hook stays `idle` instead — a caller gated on `ready`/`failed` waits, which is
 * the honest thing to do. `[]` is a real answer (no visible projects) and reads:
 * it still returns the notifications the archive recorded no project for.
 */
export function useNotificationTraffic(
	projectIds: readonly string[] | null,
): NotificationTrafficView {
	const { isLocked } = useProjectPrivacy();
	const [, setTick] = useState(0);
	useEffect(
		() => subscribeNotificationTraffic(() => setTick((value) => value + 1)),
		[],
	);
	// A join, not the array: a caller rebuilding the same ids every render must not
	// re-read the archive on every render.
	const key = projectIds ? [...projectIds].sort().join(",") : null;
	useEffect(() => {
		if (key === null) return;
		void loadNotificationTraffic({
			projectIds: key.length ? key.split(",") : [],
		});
		const onChange = () => noteNotificationArrival();
		window.addEventListener("rpc:notificationLogChanged", onChange);
		return () =>
			window.removeEventListener("rpc:notificationLogChanged", onChange);
	}, [key]);
	const state = getNotificationTrafficState();
	const events = useMemo(
		() =>
			key === null
				? []
				: notificationEvents(
						// The reader scoped by target project; a row can still name a SOURCE
						// project the user locked, and that project's title travelled with it.
						state.rows.filter((row) => !isLocked(row.sourceProjectId)),
					),
		[state.rows, isLocked, key],
	);
	return { events, status: key === null ? "idle" : statusOf(state) };
}
