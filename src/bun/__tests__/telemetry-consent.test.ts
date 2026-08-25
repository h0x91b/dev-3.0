/**
 * The opt-out verdict. Guards the shape of the thing an audit found missing: in a
 * released build the only gate was a build-time variable that could never be set,
 * so the comparison folded to "on" and no runtime escape existed at all.
 */
import { describe, it, expect } from "vitest";
import {
	doNotTrackOptsOut,
	envOptsOut,
	resolveTelemetryOptOut,
	TELEMETRY_OFF_VALUES,
} from "../../shared/telemetry-consent";

describe("DEV3_TELEMETRY", () => {
	it.each(TELEMETRY_OFF_VALUES)("treats %s as off", (value) => {
		expect(envOptsOut(value)).toBe(true);
	});

	it("is forgiving about case and stray whitespace", () => {
		expect(envOptsOut("  OFF ")).toBe(true);
		expect(envOptsOut("False")).toBe(true);
	});

	it("leaves telemetry on when unset or set to anything else", () => {
		expect(envOptsOut(undefined)).toBe(false);
		expect(envOptsOut("")).toBe(false);
		expect(envOptsOut("on")).toBe(false);
		expect(envOptsOut("1")).toBe(false);
	});
});

describe("DO_NOT_TRACK", () => {
	it("opts out on every truthy spelling the convention uses", () => {
		for (const value of ["1", "true", "yes", "on", " TRUE "]) {
			expect(doNotTrackOptsOut(value)).toBe(true);
		}
	});

	it("does not opt out when absent or explicitly zero", () => {
		expect(doNotTrackOptsOut(undefined)).toBe(false);
		expect(doNotTrackOptsOut("")).toBe(false);
		expect(doNotTrackOptsOut("0")).toBe(false);
		expect(doNotTrackOptsOut("false")).toBe(false);
	});
});

describe("resolveTelemetryOptOut", () => {
	it("runs telemetry when nothing asked otherwise", () => {
		expect(resolveTelemetryOptOut({}, {})).toBeNull();
	});

	it("names each source", () => {
		expect(resolveTelemetryOptOut({ DEV3_TELEMETRY: "off" }, {})).toBe("env");
		expect(resolveTelemetryOptOut({ DO_NOT_TRACK: "1" }, {})).toBe("do-not-track");
		expect(resolveTelemetryOptOut({}, { telemetryDisabled: true })).toBe("setting");
	});

	it("reports the environment first, so the UI names what it cannot change", () => {
		const both = resolveTelemetryOptOut({ DEV3_TELEMETRY: "off" }, { telemetryDisabled: true });
		expect(both).toBe("env");
	});

	it("does not read a false setting as an opt-out", () => {
		expect(resolveTelemetryOptOut({}, { telemetryDisabled: false })).toBeNull();
	});
});
