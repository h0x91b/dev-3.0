import type { TelemetryOptOutSource } from "../shared/telemetry-consent";
import { TELEMETRY_OFF_VALUES } from "../shared/telemetry-consent";

/**
 * Three independent ways to switch every telemetry channel off, any one of which
 * is enough. They exist at different times, which is why there are three:
 *
 * 1. Build time — `VITE_TELEMETRY=off` compiles the channels out entirely. Read
 *    per call so Vite constant-folds it in a build while `vi.stubEnv` can still
 *    flip it in tests.
 * 2. Boot time — the host resolves `DEV3_TELEMETRY` / `DO_NOT_TRACK` / the stored
 *    setting and injects the verdict as `window.__DEV3_TELEMETRY_OPT_OUT__` before
 *    any page script runs (see src/bun/analytics-identity.ts).
 * 3. Run time — flipping the Settings toggle, which must take effect on the spot
 *    rather than at the next launch.
 *
 * A released binary only ever has the last two, and before this existed it had
 * neither: the build-time check was the only gate, so in a shipped build the
 * comparison folded against an unset variable and could only ever return "on".
 */
declare global {
	interface Window {
		__DEV3_TELEMETRY_OPT_OUT__?: TelemetryOptOutSource;
	}
}

let runtimeOptOut = false;

/** Build-time verdict: was telemetry compiled out of this bundle? */
function compiledOut(): boolean {
	const value = String(import.meta.env.VITE_TELEMETRY ?? "").trim().toLowerCase();
	return (TELEMETRY_OFF_VALUES as readonly string[]).includes(value);
}

/**
 * Who opted this install out, or null when telemetry may run. Callers that only
 * need a yes/no want {@link telemetryEnabled}; this one names the source so the
 * UI can say *why* the toggle is off and stop the user hunting for it.
 */
export function telemetryOptOutSource(): TelemetryOptOutSource | null {
	if (compiledOut()) return "env";
	if (runtimeOptOut) return "setting";
	return (typeof window !== "undefined" && window.__DEV3_TELEMETRY_OPT_OUT__) || null;
}

export function telemetryEnabled(): boolean {
	return telemetryOptOutSource() === null;
}

/**
 * Apply a Settings-toggle change without waiting for a relaunch.
 *
 * Switching off lands immediately and everywhere: the GA transport asks per send,
 * and posthog.ts opts its client out. Switching back on cannot resurrect a PostHog
 * client that was never initialized this launch, so the UI says a restart is
 * needed — the honest half-answer beats a toggle that silently does nothing.
 */
export function setRuntimeTelemetryOptOut(optedOut: boolean): void {
	runtimeOptOut = optedOut;
}

/** Reset module state between tests. */
export function _resetTelemetryRuntimeStateForTests(): void {
	runtimeOptOut = false;
}
