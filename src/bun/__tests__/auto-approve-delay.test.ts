import { describe, it, expect } from "vitest";
import {
	AGENT_LAUNCH_AUTO_APPROVE_MAX_MS,
	AGENT_LAUNCH_AUTO_APPROVE_MIN_MS,
	DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES,
	agentLaunchAutoApproveMs,
	autoApproveMinutesFromHms,
	splitAutoApproveHms,
} from "../../shared/types";

describe("auto-approve delay — the hours/minutes/seconds picker", () => {
	// The whole point of the three fields: they had to become storable without a
	// new on-disk key, so an older build still reads them.
	it.each([
		["15 seconds", { hours: 0, minutes: 0, seconds: 15 }, 15_000],
		["10 minutes", { hours: 0, minutes: 10, seconds: 0 }, 600_000],
		["1 hour", { hours: 1, minutes: 0, seconds: 0 }, 3_600_000],
		["1h 30m 45s", { hours: 1, minutes: 30, seconds: 45 }, 5_445_000],
	])("stores and resolves %s", (_label, hms, expectedMs) => {
		const minutes = autoApproveMinutesFromHms(hms);
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: minutes })).toBe(expectedMs);
	});

	it("round-trips a stored value back into the three fields", () => {
		const hms = { hours: 2, minutes: 7, seconds: 9 };
		expect(splitAutoApproveHms(autoApproveMinutesFromHms(hms))).toEqual(hms);
	});

	it("splits 90 minutes into 1 hour 30 minutes", () => {
		expect(splitAutoApproveHms(90)).toEqual({ hours: 1, minutes: 30, seconds: 0 });
	});

	it("reads the stored default without leftover seconds", () => {
		expect(splitAutoApproveHms(DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES)).toEqual({
			hours: 0,
			minutes: 5,
			seconds: 0,
		});
	});
});

describe("auto-approve delay — zero, missing and nonsense", () => {
	it("treats 0 as the user's stored 'never', not as a missing value", () => {
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: 0 })).toBe(0);
	});

	it("falls back to the built-in default when nothing is stored", () => {
		expect(agentLaunchAutoApproveMs({})).toBe(DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES * 60_000);
	});

	it.each([[-5], [Number.NaN], [Number.POSITIVE_INFINITY]])("reads %s as off rather than throwing", (value) => {
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: value })).toBe(0);
	});

	it("clamps a hand-edited value into the accepted range instead of honouring it", () => {
		// A week would park a requesting agent for a week; a millisecond would fire
		// before the dialog could paint.
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: 7 * 24 * 60 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MAX_MS);
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: 0.001 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MIN_MS);
	});

	it("clamps through the picker too, so the fields cannot store an out-of-range delay", () => {
		expect(autoApproveMinutesFromHms({ hours: 500, minutes: 0, seconds: 0 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MAX_MS / 60_000);
		expect(autoApproveMinutesFromHms({ hours: 0, minutes: 0, seconds: 0 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MIN_MS / 60_000);
	});

	it("reads an empty or negative field as zero for that unit, keeping the others", () => {
		// An emptied input arrives as NaN; it must not wipe the whole delay.
		expect(autoApproveMinutesFromHms({ hours: Number.NaN, minutes: 10, seconds: -3 })).toBe(10);
	});

	it("never shows negative fields for a nonsense stored value", () => {
		expect(splitAutoApproveHms(Number.NaN)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
		expect(splitAutoApproveHms(-5)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
	});
});
