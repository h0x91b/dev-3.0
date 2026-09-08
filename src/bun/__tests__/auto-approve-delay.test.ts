import { describe, it, expect } from "vitest";
import {
	AGENT_LAUNCH_AUTO_APPROVE_MAX_MS,
	AGENT_LAUNCH_AUTO_APPROVE_MIN_MS,
	DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES,
	agentLaunchAutoApproveMs,
	autoApproveMinutesFrom,
	maxAutoApproveAmount,
	splitAutoApproveMinutes,
} from "../../shared/types";

describe("auto-approve delay — the three units are all representable", () => {
	// The whole point of the amount+unit picker: these three had to become
	// storable without a new on-disk key, so an older build still reads them.
	it.each([
		["15 seconds", 15, "seconds" as const, 15_000],
		["10 minutes", 10, "minutes" as const, 600_000],
		["1 hour", 1, "hours" as const, 3_600_000],
	])("stores and resolves %s", (_label, amount, unit, expectedMs) => {
		const minutes = autoApproveMinutesFrom(amount, unit);
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: minutes })).toBe(expectedMs);
	});

	it("round-trips a stored value back to the unit a human would have picked", () => {
		expect(splitAutoApproveMinutes(autoApproveMinutesFrom(15, "seconds"))).toEqual({ amount: 15, unit: "seconds" });
		expect(splitAutoApproveMinutes(autoApproveMinutesFrom(10, "minutes"))).toEqual({ amount: 10, unit: "minutes" });
		expect(splitAutoApproveMinutes(autoApproveMinutesFrom(1, "hours"))).toEqual({ amount: 1, unit: "hours" });
	});

	it("keeps 90 minutes as minutes rather than inventing 1.5 hours", () => {
		expect(splitAutoApproveMinutes(90)).toEqual({ amount: 90, unit: "minutes" });
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

	it("clamps through the picker too, so the input cannot store an out-of-range amount", () => {
		expect(autoApproveMinutesFrom(500, "hours")).toBe(AGENT_LAUNCH_AUTO_APPROVE_MAX_MS / 60_000);
		expect(autoApproveMinutesFrom(0, "minutes")).toBe(DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES);
	});

	it("offers the picker a per-unit ceiling matching the clamp", () => {
		expect(maxAutoApproveAmount("hours")).toBe(24);
		expect(maxAutoApproveAmount("minutes")).toBe(24 * 60);
		expect(maxAutoApproveAmount("seconds")).toBe(24 * 60 * 60);
	});
});
