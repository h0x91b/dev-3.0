/**
 * Feature-flag refresh loop. The renderer owns evaluation (posthog-js lives here)
 * and pushes the values to the bun process, which reads them synchronously on hot
 * paths.
 *
 * Only the Electrobun renderer refreshes: it exists exactly once per install, so
 * one poller per machine rather than one per attached browser. The *identity* is
 * shared either way — bun owns the distinct id and every renderer reports the
 * same one, so a percentage rollout cannot half-enable a machine.
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

/** Ask PostHog for fresh values now instead of waiting out the refresh timer. */
export function refreshFeatureFlagsNow(): void {
	posthog.reloadFeatureFlags();
}

export function initFeatureFlags(): void {
	// Offer this renderer's own posthog-js id as the seed. bun keeps the first one
	// it is ever given, so an existing install adopts the id it already had rather
	// than minting a second person for the same machine.
	api.request
		.resolveAnalyticsDistinctId({ seed: posthog.get_distinct_id() || undefined })
		.catch(() => {});

	if (!isElectrobun) return;
	posthog.onFeatureFlags(() => pushFlagsToBun());
	setInterval(() => posthog.reloadFeatureFlags(), FEATURE_FLAG_REFRESH_MS);
}
