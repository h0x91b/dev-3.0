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
	it("stores and resolves every unit combination", () => {
		const cases: [string, { hours: number; minutes: number; seconds: number }, number][] = [
			["15 seconds", { hours: 0, minutes: 0, seconds: 15 }, 15_000],
			["10 minutes", { hours: 0, minutes: 10, seconds: 0 }, 600_000],
			["1 hour", { hours: 1, minutes: 0, seconds: 0 }, 3_600_000],
			["1h 30m 45s", { hours: 1, minutes: 30, seconds: 45 }, 5_445_000],
		];
		for (const [label, hms, expectedMs] of cases) {
			const minutes = autoApproveMinutesFromHms(hms);
			expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: minutes }), label).toBe(expectedMs);
		}
	});

	it("splits a stored value back into the three fields", () => {
		const hms = { hours: 2, minutes: 7, seconds: 9 };
		expect(splitAutoApproveHms(autoApproveMinutesFromHms(hms)), "round trip").toEqual(hms);
		expect(splitAutoApproveHms(90)).toEqual({ hours: 1, minutes: 30, seconds: 0 });
		// The stored default reads without leftover seconds.
		expect(splitAutoApproveHms(DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES)).toEqual({ hours: 0, minutes: 1, seconds: 0 });
	});
});

describe("auto-approve delay — zero, missing and nonsense", () => {
	it("honours a configured delay, keeps 0 as the stored 'never', and waits a minute when nothing is stored", () => {
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: 30 })).toBe(30 * 60_000);
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: 0 }), "0 is never, not missing").toBe(0);
		// The delay only covers an absent user — the countdown stops the moment
		// anyone touches the dialog, so a longer unattended wait buys nothing.
		expect(agentLaunchAutoApproveMs({})).toBe(DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES * 60_000);
		expect(agentLaunchAutoApproveMs({})).toBe(60_000);
	});

	it("reads nonsense as off and clamps a hand-edited value into the accepted range", () => {
		for (const value of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: value }), String(value)).toBe(0);
		}
		// A week would park a requesting agent for a week; a millisecond would fire
		// before the dialog could paint.
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: 7 * 24 * 60 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MAX_MS);
		expect(agentLaunchAutoApproveMs({ agentLaunchAutoApproveMinutes: 0.001 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MIN_MS);
	});

	it("clamps through the picker too, reading an empty or negative field as zero for that unit", () => {
		expect(autoApproveMinutesFromHms({ hours: 500, minutes: 0, seconds: 0 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MAX_MS / 60_000);
		expect(autoApproveMinutesFromHms({ hours: 0, minutes: 0, seconds: 0 })).toBe(AGENT_LAUNCH_AUTO_APPROVE_MIN_MS / 60_000);
		// An emptied input arrives as NaN; it must not wipe the whole delay.
		expect(autoApproveMinutesFromHms({ hours: Number.NaN, minutes: 10, seconds: -3 })).toBe(10);
	});

	it("never shows negative fields for a nonsense stored value", () => {
		expect(splitAutoApproveHms(Number.NaN)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
		expect(splitAutoApproveHms(-5)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
	});
});
