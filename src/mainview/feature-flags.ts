/**
 * Feature-flag refresh loop. The renderer owns evaluation (posthog-js is already
 * initialized here and already owns the distinct id) and pushes the values to the
 * bun process, which reads them synchronously on hot paths.
 *
 * Only the Electrobun renderer runs this: it is the one renderer that exists
 * exactly once per install, so the flags a machine acts on come from a single
 * distinct id. A remote browser has its own anonymous id and would bucket
 * differently on a percentage rollout, giving one machine two answers.
 *
 * See decisions/2026/08/08/first-posthog-feature-flag.md.
 */
import posthog from "./posthog";
import { api, isElectrobun } from "./rpc";
import { FEATURE_FLAG_KEYS, FEATURE_FLAG_REFRESH_MS, type FeatureFlagKey } from "../shared/feature-flags";

function pushFlagsToBun(): void {
	const flags = {} as Record<FeatureFlagKey, boolean>;
	for (const key of FEATURE_FLAG_KEYS) flags[key] = posthog.getFeatureFlag(key) === true;
	api.request.setFeatureFlags({ flags }).catch(() => {
		// A dropped push leaves bun on its last known value, which is the point.
	});
}

/**
 * Start the refresh loop. `onFeatureFlags` fires after every successful load,
 * including the first, so the push is driven by PostHog rather than by a guess
 * at when the values are ready.
 *
 * `reloadFeatureFlags()` is deliberately fire-and-forget: it is neither awaitable
 * nor reactive, and the cached value keeps being served while a refetch is in
 * flight. Holding the last known value through an outage is the behaviour we want.
 */
export function initFeatureFlags(): void {
	if (!isElectrobun) return;
	posthog.onFeatureFlags(() => pushFlagsToBun());
	setInterval(() => posthog.reloadFeatureFlags(), FEATURE_FLAG_REFRESH_MS);
}
