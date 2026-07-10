import type { FavoriteAgentConfig } from "./types";

/**
 * Pure operations on the user's favorite agent configurations (thin
 * `(agentId, configId)` pointers stored in `GlobalSettings.favorites`).
 *
 * These helpers are shared between the bun main process (toggle RPC + usage
 * increment) and the renderer (chip ordering). They never read the clock — the
 * caller passes `now` (epoch ms) so the logic stays deterministic and testable.
 * See docs/ux/feature-plans/agent-favorites.md + decisions/125-agent-favorites.md.
 */

/** Hard cap on stored favorites. Adding past this evicts (see toggleFavorite). */
export const MAX_FAVORITES = 10;

function samePair(f: FavoriteAgentConfig, agentId: string, configId: string): boolean {
	return f.agentId === agentId && f.configId === configId;
}

/** True when `(agentId, configId)` is already a favorite. */
export function isFavorite(
	favorites: FavoriteAgentConfig[],
	agentId: string,
	configId: string,
): boolean {
	return favorites.some((f) => samePair(f, agentId, configId));
}

/**
 * Add or remove `(agentId, configId)`. Removing drops the entry. Adding appends
 * a fresh entry (`uses: 0`, `lastUsedAt: now`); once the list is at
 * MAX_FAVORITES the lowest-`uses` **existing** entry is evicted first (ties
 * broken by oldest `lastUsedAt` — LFU then LRU). The just-added entry is never
 * the eviction victim, so an explicit "add" always takes effect. Pure — never
 * mutates the input.
 */
export function toggleFavorite(
	favorites: FavoriteAgentConfig[],
	agentId: string,
	configId: string,
	now: number,
): FavoriteAgentConfig[] {
	if (isFavorite(favorites, agentId, configId)) {
		return favorites.filter((f) => !samePair(f, agentId, configId));
	}
	const entry: FavoriteAgentConfig = { agentId, configId, uses: 0, lastUsedAt: now };
	if (favorites.length < MAX_FAVORITES) return [...favorites, entry];

	// Full: evict the weakest existing entry (min uses, tie min lastUsedAt).
	let victim = 0;
	for (let i = 1; i < favorites.length; i++) {
		const f = favorites[i];
		const v = favorites[victim];
		if (f.uses < v.uses || (f.uses === v.uses && f.lastUsedAt < v.lastUsedAt)) victim = i;
	}
	return [...favorites.slice(0, victim), ...favorites.slice(victim + 1), entry];
}

/**
 * Bump `uses` and refresh `lastUsedAt` for the matching favorite (called once
 * per spawned agent on any launch of that combo). Returns the original array
 * unchanged when the pair is not a favorite, so callers can skip a save.
 */
export function recordFavoriteUsage(
	favorites: FavoriteAgentConfig[],
	agentId: string,
	configId: string,
	now: number,
): FavoriteAgentConfig[] {
	if (!isFavorite(favorites, agentId, configId)) return favorites;
	return favorites.map((f) =>
		samePair(f, agentId, configId) ? { ...f, uses: f.uses + 1, lastUsedAt: now } : f,
	);
}

/** Display order: most-used first, ties broken by most-recently-used. Pure. */
export function orderFavorites(favorites: FavoriteAgentConfig[]): FavoriteAgentConfig[] {
	return [...favorites].sort((a, b) => b.uses - a.uses || b.lastUsedAt - a.lastUsedAt);
}

/**
 * Validate `favorites` loaded from disk: keep only well-formed entries (non-empty
 * string ids; numeric counters defaulted to 0), cap at MAX_FAVORITES, and return
 * `undefined` for a missing/empty/invalid value so it stays out of settings.json.
 */
export function sanitizeFavorites(raw: unknown): FavoriteAgentConfig[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: FavoriteAgentConfig[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		if (typeof r.agentId !== "string" || !r.agentId) continue;
		if (typeof r.configId !== "string" || !r.configId) continue;
		out.push({
			agentId: r.agentId,
			configId: r.configId,
			uses: typeof r.uses === "number" && r.uses >= 0 ? r.uses : 0,
			lastUsedAt: typeof r.lastUsedAt === "number" && r.lastUsedAt >= 0 ? r.lastUsedAt : 0,
		});
		if (out.length >= MAX_FAVORITES) break;
	}
	return out.length > 0 ? out : undefined;
}
