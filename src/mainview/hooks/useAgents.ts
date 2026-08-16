import { useEffect, useState } from "react";
import type { CodingAgent } from "../../shared/types";
import { api } from "../rpc";

/**
 * The agent presets, kept current for the lifetime of the surface.
 *
 * A board or launch picker outlives every visit to Settings, so a
 * fetch-once snapshot goes stale the moment a preset is added, renamed or
 * deleted — the picker then offers a preset that no longer exists. Follows the
 * `agentsUpdated` push the backend fans out on every save, the same way
 * `useTaskSortOrder` follows `globalSettingsUpdated`.
 */
export function useAgents(): CodingAgent[] {
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
		function onUpdated(e: Event) {
			setAgents((e as CustomEvent<CodingAgent[]>).detail);
		}
		window.addEventListener("rpc:agentsUpdated", onUpdated);
		return () => window.removeEventListener("rpc:agentsUpdated", onUpdated);
	}, []);
	return agents;
}
