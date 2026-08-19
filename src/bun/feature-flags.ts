/**
 * Feature-flag cache for the bun process.
 *
 * The bun process never talks to PostHog: the Electrobun renderer evaluates the
 * flags and pushes them here over RPC (`setFeatureFlags`). Reads are synchronous
 * and cheap enough for a hot path such as `enqueuePtyData`.
 */
import { FEATURE_FLAG_DEFAULTS, FEATURE_FLAG_KEYS, type FeatureFlagKey } from "../shared/feature-flags";

const values = new Map<FeatureFlagKey, boolean>();

/** Cached read. Falls back to the shipped default until a value is pushed. */
export function isFeatureEnabled(key: FeatureFlagKey): boolean {
	const cached = values.get(key);
	return cached === undefined ? FEATURE_FLAG_DEFAULTS[key] : cached;
}

/**
 * Merge a pushed batch. A key missing from the payload keeps its last known
 * value rather than reverting — an unreachable PostHog must not silently flip
 * behaviour, only an explicit `false` may.
 */
export function setFeatureFlags(flags: Record<string, boolean>): void {
	for (const key of FEATURE_FLAG_KEYS) {
		const value = flags[key];
		if (typeof value === "boolean") values.set(key, value);
	}
}

/** Every declared flag with its effective value — what the code actually gates on. */
export function getAllFeatureFlags(): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const key of FEATURE_FLAG_KEYS) out[key] = isFeatureEnabled(key);
	return out;
}

export function _resetFeatureFlagsForTests(): void {
	values.clear();
}
