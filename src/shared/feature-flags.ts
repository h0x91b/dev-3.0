/**
 * PostHog feature flags the app reads, shared by the renderer (which evaluates
 * them) and the bun process (which caches the pushed values).
 *
 * Flags are read synchronously from a cache; the renderer refreshes them every
 * FEATURE_FLAG_REFRESH_MS. PostHog has no push channel, so that interval is
 * also the worst-case propagation delay of a rollout or a kill.
 * See decisions/2026/08/08/first-posthog-feature-flag.md.
 */

/**
 * No flag is declared right now: `remote-terminal-latency` graduated — the
 * leading-edge flush and broadcast backpressure are the only path in
 * `src/bun/pty-server.ts`, so there is nothing left to gate. Declaring the next
 * flag here is all it takes to bring the loop below back to life.
 */
export const FEATURE_FLAGS = {} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] =
	Object.values(FEATURE_FLAGS) as FeatureFlagKey[];

/**
 * Served before the first successful fetch, when PostHog is unreachable, and
 * when no PostHog key is configured: every flag is off, i.e. the behaviour the
 * app already shipped.
 */
export const FEATURE_FLAG_DEFAULTS: Record<FeatureFlagKey, boolean> = {};

/** How often the renderer re-asks PostHog. Tune here, never at a call site. */
export const FEATURE_FLAG_REFRESH_MS = 5 * 60 * 1000;
