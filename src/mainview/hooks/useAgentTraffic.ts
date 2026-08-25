import { useEffect, useState } from "react";
import {
	derivePairs,
	getTrafficState,
	loadTraffic,
	subscribeTraffic,
	trafficSeenAt,
	unreadRows,
	type TrafficPair,
	type TrafficState,
} from "../agent-traffic";

export interface AgentTraffic extends TrafficState {
	pairs: TrafficPair[];
	/** How many messages landed since the user last looked. */
	unread: number;
	/** True while any unread message has no proof of delivery. */
	unreadUnsettled: boolean;
}

/**
 * One project's agent traffic, kept in sync with the shared store.
 *
 * The store is module-level rather than React state because two surfaces read it
 * (the header readout and the traffic log) and a message arriving — or the user
 * marking the traffic seen — must move both without either owning the other.
 */
export function useAgentTraffic(projectId: string | null | undefined): AgentTraffic {
	const [state, setState] = useState<TrafficState>(() => getTrafficState(projectId));
	// Re-read on every store notification: `markTrafficSeen` emits, and the unread
	// count is derived from a stamp that lives outside React.
	const [, setSeenTick] = useState(0);

	useEffect(() => {
		setState(getTrafficState(projectId));
		if (!projectId) return;
		const unsubscribe = subscribeTraffic((changed) => {
			setSeenTick((tick) => tick + 1);
			if (changed === projectId) setState(getTrafficState(projectId));
		});
		if (!getTrafficState(projectId).loaded) void loadTraffic(projectId);
		return unsubscribe;
	}, [projectId]);

	const pairs = derivePairs(state.rows);
	const unread = unreadRows(state.rows, trafficSeenAt());
	return {
		...state,
		pairs,
		unread: unread.length,
		unreadUnsettled: unread.some((row) => row.status === "unconfirmed" || row.status === "not-delivered"),
	};
}
