import { useCallback } from "react";
import { api } from "../rpc";
import type { GlobalSettings } from "../../shared/types";

/**
 * Returns a handler that stars / unstars a (agentId, configId) combo. The bun
 * handler owns the cap + eviction and returns the fresh settings; `applySettings`
 * bubbles them wherever the caller keeps GlobalSettings (lifted via a parent
 * callback, or a local useState setter). Favorites are a convenience — a toggle
 * failure is swallowed, never surfaced.
 */
export function useToggleFavorite(applySettings?: (settings: GlobalSettings) => void) {
	return useCallback(
		async (agentId: string, configId: string) => {
			try {
				const updated = await api.request.toggleFavoriteAgent({ agentId, configId });
				applySettings?.(updated);
			} catch {
				// Favorites are a convenience; never surface a toggle failure.
			}
		},
		[applySettings],
	);
}
