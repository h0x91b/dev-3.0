import { useEffect, useState } from "react";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import { api } from "../rpc";

/** The latest rate-limit report: fetched once, then kept current by the monitor's push. */
export function useAgentRateLimitsReport(): AgentRateLimitsReport | null {
	const [report, setReport] = useState<AgentRateLimitsReport | null>(null);
	useEffect(() => {
		api.request.getAgentRateLimits().then(setReport).catch(() => {
			// backend not ready - the first push fills it in
		});
		function onUpdate(e: Event) {
			setReport((e as CustomEvent).detail as AgentRateLimitsReport);
		}
		window.addEventListener("rpc:agentRateLimitsUpdated", onUpdate);
		return () => window.removeEventListener("rpc:agentRateLimitsUpdated", onUpdate);
	}, []);
	return report;
}
