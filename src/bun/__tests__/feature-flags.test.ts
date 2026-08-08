import { describe, it, expect, beforeEach } from "vitest";
import { isFeatureEnabled, setFeatureFlags, _resetFeatureFlagsForTests } from "../feature-flags";
import { FEATURE_FLAGS, FEATURE_FLAG_DEFAULTS, FEATURE_FLAG_REFRESH_MS } from "../../shared/feature-flags";

const FLAG = FEATURE_FLAGS.remoteTerminalLatency;

beforeEach(() => {
	_resetFeatureFlagsForTests();
});

describe("bun feature-flag cache", () => {
	it("serves the shipped default before the renderer has pushed anything", () => {
		expect(isFeatureEnabled(FLAG)).toBe(FEATURE_FLAG_DEFAULTS[FLAG]);
		expect(FEATURE_FLAG_DEFAULTS[FLAG]).toBe(false);
	});

	it("takes the pushed value in both directions", () => {
		setFeatureFlags({ [FLAG]: true });
		expect(isFeatureEnabled(FLAG)).toBe(true);
		setFeatureFlags({ [FLAG]: false });
		expect(isFeatureEnabled(FLAG)).toBe(false);
	});

	it("holds the last known value when a key is missing from the push", () => {
		setFeatureFlags({ [FLAG]: true });
		setFeatureFlags({});
		expect(isFeatureEnabled(FLAG)).toBe(true);
	});

	it("ignores non-boolean values rather than coercing them", () => {
		setFeatureFlags({ [FLAG]: true });
		setFeatureFlags({ [FLAG]: undefined as unknown as boolean });
		expect(isFeatureEnabled(FLAG)).toBe(true);
		setFeatureFlags({ [FLAG]: "false" as unknown as boolean });
		expect(isFeatureEnabled(FLAG)).toBe(true);
	});

	it("ignores keys the app does not declare", () => {
		setFeatureFlags({ "some-other-flag": true });
		expect(isFeatureEnabled(FLAG)).toBe(false);
	});

	it("refreshes every 5 minutes — the accepted worst-case propagation delay", () => {
		expect(FEATURE_FLAG_REFRESH_MS).toBe(5 * 60 * 1000);
	});
});
