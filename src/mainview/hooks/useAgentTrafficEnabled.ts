import { useEffect, useState } from "react";
import {
	AGENT_TRAFFIC_FLAG_CHANGED_EVENT,
	getAgentTrafficEnabled,
} from "../agent-traffic-flag";

/** Whether the agent-traffic beta is on, re-rendering when the user toggles it. */
export function useAgentTrafficEnabled(): boolean {
	const [enabled, setEnabled] = useState(getAgentTrafficEnabled);

	useEffect(() => {
		function onChanged() {
			setEnabled(getAgentTrafficEnabled());
		}
		window.addEventListener(AGENT_TRAFFIC_FLAG_CHANGED_EVENT, onChanged);
		// The flag may have landed between render and this effect.
		onChanged();
		return () => window.removeEventListener(AGENT_TRAFFIC_FLAG_CHANGED_EVENT, onChanged);
	}, []);

	return enabled;
}
