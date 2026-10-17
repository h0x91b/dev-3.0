import { useEffect, useState } from "react";
import type { LiveModel } from "../../shared/agent-live-models";
import type { CodingAgent } from "../../shared/types";
import { api } from "../rpc";

/**
 * The models the agent CLI reports for the picker's account (omp, pi), newest
 * first. Null while loading and whenever the answer is unknown — the picker then
 * shows only the agent's presets, exactly as before. Re-asks when the agent or
 * the account changes, because the account decides which providers are signed in.
 */
export function useLiveModels(agent: CodingAgent | undefined | null, accountId?: string | null): LiveModel[] | null {
	const [models, setModels] = useState<LiveModel[] | null>(null);
	const agentId = agent?.id ?? null;
	useEffect(() => {
		setModels(null);
		if (!agentId) return;
		let cancelled = false;
		// Inside the chain, so an RPC missing from a partial test mock is a caught
		// rejection rather than a crashed picker.
		Promise.resolve()
			.then(() => api.request.getAgentLiveModels({ agentId, accountId }))
			.then((result) => {
				if (!cancelled) setModels(result?.status === "resolved" ? result.models : null);
			})
			.catch(() => {
				if (!cancelled) setModels(null);
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, accountId]);
	return models;
}
