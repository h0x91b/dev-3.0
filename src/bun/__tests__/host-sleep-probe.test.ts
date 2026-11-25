import { describe, expect, it } from "vitest";
import { classifyGap, describeLateTick, parseSysctlTimeval } from "../host-sleep-probe";

/** Stamps shaped like the real `sysctl kern.sleeptime kern.waketime` output on macOS. */
const SLEPT_AT = 1_792_694_081_825;
const WOKE_AT = 1_792_694_207_184;

describe("parseSysctlTimeval", () => {
	it("reads the timeval sysctl prints, to the millisecond, and gives up on anything else rather than guessing", () => {
		expect(parseSysctlTimeval("kern.waketime: { sec = 1792694207, usec = 184004 } Thu Oct 22 21:36:47 2026")).toBe(WOKE_AT);
		expect(parseSysctlTimeval("")).toBeNull();
		expect(parseSysctlTimeval("sysctl: unknown oid 'kern.waketime'")).toBeNull();
	});
});

describe("classifyGap", () => {
	it("tells a sleep from a starved host, and admits when it does not know", () => {
		const cases: Array<[name: string, lastTickMs: number, stamps: Parameters<typeof classifyGap>[1], expected: ReturnType<typeof classifyGap>]> = [
			["woke inside the gap", WOKE_AT - 30_000, { sleptAtMs: SLEPT_AT, wokeAtMs: WOKE_AT }, "slept"],
			["went to sleep inside the gap, not woken since", SLEPT_AT - 2_000, { sleptAtMs: SLEPT_AT, wokeAtMs: SLEPT_AT - 600_000 }, "slept"],
			["OS stamped its sleep a moment after the last tick", SLEPT_AT + 500, { sleptAtMs: SLEPT_AT, wokeAtMs: null }, "slept"],
			// The field case: woke at 10:22:09, late ticks from 10:22:32 on.
			["last sleep and wake both predate the gap", WOKE_AT + 23_000, { sleptAtMs: SLEPT_AT, wokeAtMs: WOKE_AT }, "starved"],
			["the OS gave no stamps", WOKE_AT, { sleptAtMs: null, wokeAtMs: null }, "unknown"],
		];
		for (const [name, lastTickMs, stamps, expected] of cases) {
			expect(classifyGap(lastTickMs, stamps), name).toBe(expected);
		}
	});
});

describe("describeLateTick", () => {
	it("words each cause differently, so the log never calls a starved host a suspend", () => {
		const words = (["slept", "starved", "unknown"] as const).map(describeLateTick);
		expect(new Set(words).size).toBe(3);
		expect(describeLateTick("starved")).not.toMatch(/slept|suspend/);
	});
});
