/**
 * Which capture artifacts a host publishes. ONE exhaustive table is the source of
 * truth for parser, sinks and advertised surfaces, so a new mode cannot compile
 * into a state nobody chose — a missing key is a type error.
 */

import {
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY,
	type NativeSessionCaptureSurface,
} from "./record";

export const NATIVE_CAPTURE_MODES = ["none", "semantic", "compact", "semantic-and-compact"] as const;

export type NativeCaptureMode = (typeof NATIVE_CAPTURE_MODES)[number];

export const NATIVE_CAPTURE_MODE_ENV = "DEV3_NATIVE_SESSION_CAPTURE_MODE";

export interface CaptureModePlan {
	readonly runsParser: boolean;
	readonly semantic: boolean;
	readonly compact: boolean;
	/** Surfaces this mode may advertise, in reader-preference order. */
	readonly surfaces: readonly NativeSessionCaptureSurface[];
}

/** The whole design of the feature, in one table nobody can disagree with. */
export const CAPTURE_MODE_PLAN: Record<NativeCaptureMode, CaptureModePlan> = {
	none: { runsParser: false, semantic: false, compact: false, surfaces: [] },
	semantic: {
		runsParser: true,
		semantic: true,
		compact: false,
		surfaces: [NATIVE_SESSION_CAPTURE_CAPABILITY],
	},
	compact: {
		runsParser: true,
		semantic: false,
		compact: true,
		surfaces: [NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY],
	},
	"semantic-and-compact": {
		runsParser: true,
		semantic: true,
		compact: true,
		// Compact first: a reader prefers the cheap surface and falls back.
		surfaces: [NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY, NATIVE_SESSION_CAPTURE_CAPABILITY],
	},
};

export function captureModePlan(mode: NativeCaptureMode): CaptureModePlan {
	return CAPTURE_MODE_PLAN[mode];
}

export function isNativeCaptureMode(value: unknown): value is NativeCaptureMode {
	return typeof value === "string" && NATIVE_CAPTURE_MODES.includes(value as NativeCaptureMode);
}

/**
 * TOLERANT decoding, for an ambient environment value only: unknown or absent
 * reads as `none`, so a host launched by a different build publishes nothing
 * rather than guessing. Never use this on typed user input.
 */
export function parseCaptureMode(value: string | undefined): NativeCaptureMode {
	return isNativeCaptureMode(value) ? value : "none";
}

/** A typed argument the user got wrong. Defaulting it silently would disable capture. */
export class InvalidCaptureModeError extends Error {
	constructor(readonly received: string | undefined) {
		super(`capture mode ${JSON.stringify(received ?? null)} is not one of: ${NATIVE_CAPTURE_MODES.join(", ")}`);
		this.name = "InvalidCaptureModeError";
	}
}

/** STRICT validation, for explicit user input: a typo fails loudly. */
export function requireNativeCaptureMode(value: string | undefined): NativeCaptureMode {
	if (!isNativeCaptureMode(value)) throw new InvalidCaptureModeError(value);
	return value;
}
