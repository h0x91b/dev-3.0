/**
 * Who turned telemetry off, resolved from the host environment and settings.
 *
 * The host decides once at startup and hands the verdict to every renderer in the
 * HTML shell, because posthog-js initializes at module import — an RPC round trip
 * would land after the first events were already on the wire.
 */
export type TelemetryOptOutSource = "env" | "do-not-track" | "setting";

/**
 * Spellings that mean "off" for `DEV3_TELEMETRY`. Forgiving on purpose: someone
 * who writes `false` or `0` means off, and silently keeping telemetry on for them
 * is the expensive failure.
 */
export const TELEMETRY_OFF_VALUES = ["off", "false", "0", "no"] as const;

/** Spellings that mean "on" for the cross-vendor `DO_NOT_TRACK` convention. */
const DO_NOT_TRACK_ON_VALUES = ["1", "true", "yes", "on"];

/** Is `DEV3_TELEMETRY` set to one of the off spellings? */
export function envOptsOut(value: string | undefined): boolean {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (!normalized) return false;
	return (TELEMETRY_OFF_VALUES as readonly string[]).includes(normalized);
}

/**
 * Is `DO_NOT_TRACK` asking us to stay quiet? The convention
 * (consoledonottrack.com) is that any truthy value opts out, so an explicit `0`
 * is the only way the variable can be present and still mean "tracking is fine".
 */
export function doNotTrackOptsOut(value: string | undefined): boolean {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (!normalized) return false;
	return DO_NOT_TRACK_ON_VALUES.includes(normalized);
}

/**
 * The single opt-out verdict, or null when telemetry may run.
 *
 * Order is reporting order, not precedence — any one of the three is enough to
 * turn everything off. The environment is checked first so a machine-wide
 * variable is what the UI names, even when the toggle also happens to be set.
 */
export function resolveTelemetryOptOut(
	env: Readonly<Record<string, string | undefined>>,
	settings: { telemetryDisabled?: boolean },
): TelemetryOptOutSource | null {
	if (envOptsOut(env.DEV3_TELEMETRY)) return "env";
	if (doNotTrackOptsOut(env.DO_NOT_TRACK)) return "do-not-track";
	if (settings.telemetryDisabled === true) return "setting";
	return null;
}
