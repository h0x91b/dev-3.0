/**
 * The bun-side flag cache with an EMPTY registry, which is what the app ships
 * today: `remote-terminal-latency` graduated and nothing replaced it. What must
 * hold is that the plumbing is inert rather than broken — a push of undeclared
 * keys changes nothing, and the read side reports an empty set instead of
 * throwing. The value-caching behaviour itself is asserted the moment a flag is
 * declared again; there is nothing honest to assert about it while none is.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getAllFeatureFlags, setFeatureFlags, _resetFeatureFlagsForTests } from "../feature-flags";
import {
	FEATURE_FLAGS,
	FEATURE_FLAG_DEFAULTS,
	FEATURE_FLAG_KEYS,
	FEATURE_FLAG_REFRESH_MS,
} from "../../shared/feature-flags";

beforeEach(() => {
	_resetFeatureFlagsForTests();
});

describe("bun feature-flag cache", () => {
	it("declares no flag — the leading-edge PTY flush is unconditional now", () => {
		expect(FEATURE_FLAG_KEYS).toEqual([]);
		expect(FEATURE_FLAGS).toEqual({});
		expect(FEATURE_FLAG_DEFAULTS).toEqual({});
	});

	it("reports an empty set rather than throwing on an empty registry", () => {
		expect(getAllFeatureFlags()).toEqual({});
	});

	it("ignores keys the app does not declare, however many arrive", () => {
		setFeatureFlags({ "remote-terminal-latency": true, "some-other-flag": true });
		expect(getAllFeatureFlags()).toEqual({});
	});

	it("keeps the 5-minute cadence for whichever flag comes next", () => {
		expect(FEATURE_FLAG_REFRESH_MS).toBe(5 * 60 * 1000);
	});
});
