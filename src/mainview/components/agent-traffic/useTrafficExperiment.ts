import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_AGENT_TRAFFIC_EXPERIMENT,
	type AgentTrafficExperiment,
	type GlobalSettings,
} from "../../../shared/types";
import { api } from "../../rpc";

/**
 * Which traffic presentation the surface renders, and how a pick is stored.
 *
 * The value lives in `GlobalSettings` rather than localStorage so it follows the
 * user into `dev3 remote` browser sessions — same reasoning as the feature flag
 * next to it. It is read here instead of through App's settings fan-out because
 * only this surface cares, and only while it is open.
 *
 * **Absent is never "Experiment 1".** Nobody was ever offered the choice, so the
 * old flag alone records nothing about presentation; an install with no stored
 * pick gets the default, upgrades included.
 */
export function useTrafficExperiment(): {
	experiment: AgentTrafficExperiment;
	choose: (next: AgentTrafficExperiment) => void;
} {
	const [experiment, setExperiment] = useState<AgentTrafficExperiment>(
		DEFAULT_AGENT_TRAFFIC_EXPERIMENT,
	);
	useEffect(() => {
		let cancelled = false;
		function apply(settings: GlobalSettings) {
			if (!cancelled) {
				setExperiment(
					settings.agentTrafficExperiment ?? DEFAULT_AGENT_TRAFFIC_EXPERIMENT,
				);
			}
		}
		function onUpdate(event: Event) {
			apply((event as CustomEvent<GlobalSettings>).detail);
		}
		window.addEventListener("rpc:globalSettingsUpdated", onUpdate);
		void api.request.getGlobalSettings().then(apply).catch(() => {});
		return () => {
			cancelled = true;
			window.removeEventListener("rpc:globalSettingsUpdated", onUpdate);
		};
	}, []);
	const choose = useCallback((next: AgentTrafficExperiment) => {
		setExperiment(next);
		void (async () => {
			try {
				const settings = await api.request.getGlobalSettings();
				await api.request.saveGlobalSettings({
					...settings,
					agentTrafficExperiment: next,
				});
			} catch {
				// The pick still applies to this session; the next open re-reads disk.
			}
		})();
	}, []);
	return { experiment, choose };
}
