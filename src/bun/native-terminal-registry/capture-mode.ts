/**
 * Which capture artifacts a host publishes. One exhaustive value, never
 * overlapping booleans, so "compact" can not accidentally suppress "semantic".
 */

export const NATIVE_CAPTURE_MODES = ["none", "semantic", "compact", "semantic-and-compact"] as const;

export type NativeCaptureMode = (typeof NATIVE_CAPTURE_MODES)[number];

export const NATIVE_CAPTURE_MODE_ENV = "DEV3_NATIVE_SESSION_CAPTURE_MODE";

/** Unknown or absent reads as `none`: the safe side is publishing nothing. */
export function parseCaptureMode(value: string | undefined): NativeCaptureMode {
	return NATIVE_CAPTURE_MODES.includes(value as NativeCaptureMode) ? (value as NativeCaptureMode) : "none";
}

/** `compact` is a projection OF parsing, so every mode but `none` runs a parser. */
export function modeRunsParser(mode: NativeCaptureMode): boolean {
	return mode !== "none";
}

export function modePersistsSemantic(mode: NativeCaptureMode): boolean {
	return mode === "semantic" || mode === "semantic-and-compact";
}

export function modePersistsCompact(mode: NativeCaptureMode): boolean {
	return mode === "compact" || mode === "semantic-and-compact";
}
