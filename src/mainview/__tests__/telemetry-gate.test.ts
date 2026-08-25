/**
 * The renderer half of the opt-out. The audit that prompted this found the shipped
 * gate could only ever answer "on": the build-time variable is unset in a release,
 * so the comparison constant-folded to true and nothing at runtime could move it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	_resetTelemetryRuntimeStateForTests,
	setRuntimeTelemetryOptOut,
	telemetryEnabled,
	telemetryOptOutSource,
} from "../telemetry";

beforeEach(() => {
	_resetTelemetryRuntimeStateForTests();
	delete window.__DEV3_TELEMETRY_OPT_OUT__;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("telemetry gate", () => {
	it("runs telemetry in a normal build with nothing opted out", () => {
		expect(telemetryEnabled()).toBe(true);
		expect(telemetryOptOutSource()).toBeNull();
	});

	it("honours the host verdict injected before any page script ran", () => {
		window.__DEV3_TELEMETRY_OPT_OUT__ = "do-not-track";
		expect(telemetryEnabled()).toBe(false);
		expect(telemetryOptOutSource()).toBe("do-not-track");
	});

	it("stops on the spot when the Settings toggle flips, without a relaunch", () => {
		expect(telemetryEnabled()).toBe(true);
		setRuntimeTelemetryOptOut(true);
		expect(telemetryEnabled()).toBe(false);
		expect(telemetryOptOutSource()).toBe("setting");
	});

	it("cannot be re-enabled past a host verdict, which needs a relaunch", () => {
		window.__DEV3_TELEMETRY_OPT_OUT__ = "setting";
		setRuntimeTelemetryOptOut(false);
		expect(telemetryEnabled()).toBe(false);
	});

	it("still compiles out with VITE_TELEMETRY=off, and that outranks everything", () => {
		vi.stubEnv("VITE_TELEMETRY", "off");
		setRuntimeTelemetryOptOut(false);
		expect(telemetryEnabled()).toBe(false);
		expect(telemetryOptOutSource()).toBe("env");
	});
});
