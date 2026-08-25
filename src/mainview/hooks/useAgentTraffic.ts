import { useEffect, useState } from "react";
import {
	derivePairs,
	getTrafficState,
	livePairs,
	loadTraffic,
	subscribeTraffic,
	type TrafficPair,
	type TrafficState,
} from "../agent-traffic";

export interface AgentTraffic extends TrafficState {
	pairs: TrafficPair[];
	/** The pairs still inside the live window — what the header speaks for. */
	live: TrafficPair[];
}

/**
 * One project's agent traffic, kept in sync with the shared store.
 *
 * The store is module-level rather than React state because two surfaces read it
 * (the header readout and the traffic log) and a message arriving must move both
 * without either owning the other.
 */
export function useAgentTraffic(projectId: string | null | undefined): AgentTraffic {
	const [state, setState] = useState<TrafficState>(() => getTrafficState(projectId));

	useEffect(() => {
		setState(getTrafficState(projectId));
		if (!projectId) return;
		const unsubscribe = subscribeTraffic((changed) => {
			if (changed === projectId) setState(getTrafficState(projectId));
		});
		if (!getTrafficState(projectId).loaded) void loadTraffic(projectId);
		return unsubscribe;
	}, [projectId]);

	const pairs = derivePairs(state.rows);
	return { ...state, pairs, live: livePairs(pairs) };
}
