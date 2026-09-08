/**
 * Archived notifications, normalized and kept current.
 *
 * `projectIds` is the visibility allowlist, not a display filter: it is passed
 * into the read so a project the user marked sensitive never puts its
 * notification text on the wire. Pass `null` for "no restriction"; passing an
 * empty array means "only notifications that belong to no project", which is a
 * real question and not the same as no filter.
 */

import { useEffect, useMemo, useState } from "react";
import {
	getNotificationTrafficState,
	loadNotificationTraffic,
	noteNotificationArrival,
	subscribeNotificationTraffic,
} from "../../notification-traffic";
import { notificationEvents } from "./notification-event";

export function useNotificationTraffic(projectIds: string[] | null, limit = 500) {
	const [, setTick] = useState(0);
	useEffect(() => subscribeNotificationTraffic(() => setTick(value => value + 1)), []);
	// A stable string, so an array rebuilt on every render does not refetch.
	const scope = projectIds === null ? null : [...projectIds].sort().join("|");
	useEffect(() => {
		void loadNotificationTraffic({ limit, projectIds: scope === null ? null : (scope ? scope.split("|") : []) });
		const onChanged = () => noteNotificationArrival();
		window.addEventListener("rpc:notificationLogChanged", onChanged);
		return () => window.removeEventListener("rpc:notificationLogChanged", onChanged);
	}, [scope, limit]);
	const state = getNotificationTrafficState();
	const events = useMemo(() => notificationEvents(state.rows), [state.rows]);
	return { ...state, events };
}
