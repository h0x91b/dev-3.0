/**
 * Feature-flag refresh loop. The renderer owns evaluation (posthog-js lives here)
 * and pushes the values to the bun process, which reads them synchronously on hot
 * paths.
 *
 * Only the Electrobun renderer *polls*: it exists exactly once per install, so one
 * poller per machine rather than one per attached browser. Every renderer pushes
 * what it evaluated, though — a browser that never pushes would leave the Debug
 * window showing shipped defaults forever and make its Refresh button a no-op.
 *
 * Identity comes from the host (`window.__DEV3_DISTINCT_ID__`, see
 * src/bun/analytics-identity.ts), so all renderers evaluate as one person and a
 * percentage rollout cannot half-enable a machine.
 *
 * See decisions/2026/08/08/first-posthog-feature-flag.md.
 */
import posthog from "./posthog";
import { api, isElectrobun } from "./rpc";
import { FEATURE_FLAG_KEYS, FEATURE_FLAG_REFRESH_MS } from "../shared/feature-flags";

/** How long a manual refresh waits for PostHog before reporting no answer. */
const MANUAL_REFRESH_TIMEOUT_MS = 8000;

function pushFlagsToBun(): Promise<void> {
	const flags: Record<string, boolean> = {};
	for (const key of FEATURE_FLAG_KEYS) flags[key] = posthog.getFeatureFlag(key) === true;
	return api.request.setFeatureFlags({ flags }).catch(() => {
		// A dropped push leaves bun on its last known value, which is the point.
	});
}

/** The id PostHog evaluates this renderer as — the one a rollout must target. */
export function evaluatingDistinctId(): string {
	try {
		return posthog.get_distinct_id() || "";
	} catch {
		return "";
	}
}

/**
 * Ask PostHog for fresh values now instead of waiting out the refresh timer.
 * Resolves once the answer has been pushed to bun, or false if none arrived —
 * the caller is a button and has to show one or the other.
 */
export function refreshFeatureFlagsNow(): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (answered: boolean) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			off?.();
			resolve(answered);
		};
		const off = posthog.onFeatureFlags(() => {
			void pushFlagsToBun().then(() => finish(true));
		});
		const timer = window.setTimeout(() => finish(false), MANUAL_REFRESH_TIMEOUT_MS);
		posthog.reloadFeatureFlags();
	});
}

export function initFeatureFlags(): void {
	// Report the id PostHog actually evaluates as. The desktop renderer is
	// authoritative: its posthog-js identity outlives any attached browser, and a
	// browser that already had an identity of its own must not pin the install to it.
	api.request
		.resolveAnalyticsDistinctId({ seed: evaluatingDistinctId() || undefined, authoritative: isElectrobun })
		.catch(() => {});

	posthog.onFeatureFlags(() => void pushFlagsToBun());
	if (!isElectrobun) return;
	// Polling with nothing declared would cost every install ~8 600 PostHog
	// requests a month to learn nothing. Declaring a flag starts it again.
	if (FEATURE_FLAG_KEYS.length === 0) return;
	setInterval(() => posthog.reloadFeatureFlags(), FEATURE_FLAG_REFRESH_MS);
}
