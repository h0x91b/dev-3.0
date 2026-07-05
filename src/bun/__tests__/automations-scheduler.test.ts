import { describe, expect, it, vi } from "vitest";

// The scheduler imports the task-creation pipeline (which transitively pulls in
// Electrobun); evaluateDue is pure, so stub the heavy modules out.
vi.mock("../rpc-handlers/task-lifecycle", () => ({ createAutomationTask: vi.fn() }));
vi.mock("../rpc-handlers/shared", () => ({ getPushMessage: () => undefined }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { MISSED_GRACE_MS, evaluateDue } from "../automations-scheduler";
import { parseRRule } from "../../shared/rrule";

const spec = parseRRule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
const anchor = new Date("2026-01-01T00:00:00Z");
const tz = "UTC";

describe("evaluateDue", () => {
	it("returns nothing when nextRunAt is in the future", () => {
		const result = evaluateDue(
			new Date("2026-07-06T09:00:00Z"),
			new Date("2026-07-05T12:00:00Z"),
			spec, tz, anchor, "skip",
		);
		expect(result).toEqual({ missed: [], due: null, dueIsCatchUp: false });
	});

	it("fires a fresh occurrence (normal tick, seconds late)", () => {
		const next = new Date("2026-07-05T09:00:00Z");
		const now = new Date("2026-07-05T09:00:25Z");
		const result = evaluateDue(next, now, spec, tz, anchor, "skip");
		expect(result.due?.toISOString()).toBe("2026-07-05T09:00:00.000Z");
		expect(result.missed).toEqual([]);
		expect(result.dueIsCatchUp).toBe(false);
	});

	it("classifies occurrences older than the grace window as missed (skip policy)", () => {
		const next = new Date("2026-07-02T09:00:00Z");
		const now = new Date("2026-07-05T12:00:00Z"); // 3 days offline
		const result = evaluateDue(next, now, spec, tz, anchor, "skip");
		expect(result.due).toBeNull();
		expect(result.missed.map((d) => d.toISOString())).toEqual([
			"2026-07-02T09:00:00.000Z",
			"2026-07-03T09:00:00.000Z",
			"2026-07-04T09:00:00.000Z",
			"2026-07-05T09:00:00.000Z",
		]);
	});

	it("promotes exactly one catch-up fire with runOnce policy", () => {
		const next = new Date("2026-07-02T09:00:00Z");
		const now = new Date("2026-07-05T12:00:00Z");
		const result = evaluateDue(next, now, spec, tz, anchor, "runOnce");
		expect(result.due?.toISOString()).toBe("2026-07-05T09:00:00.000Z"); // the latest missed
		expect(result.dueIsCatchUp).toBe(true);
		expect(result.missed.map((d) => d.toISOString())).toEqual([
			"2026-07-02T09:00:00.000Z",
			"2026-07-03T09:00:00.000Z",
			"2026-07-04T09:00:00.000Z",
		]);
	});

	it("fires the fresh occurrence AND records older ones as missed after a short sleep", () => {
		const next = new Date("2026-07-04T09:00:00Z");
		const now = new Date("2026-07-05T09:01:00Z"); // woke up right after today's occurrence
		const result = evaluateDue(next, now, spec, tz, anchor, "skip");
		expect(result.due?.toISOString()).toBe("2026-07-05T09:00:00.000Z");
		expect(result.dueIsCatchUp).toBe(false);
		expect(result.missed.map((d) => d.toISOString())).toEqual(["2026-07-04T09:00:00.000Z"]);
	});

	it("never fires more than once per evaluation", () => {
		// Minute-level rule with a gap slightly larger than grace.
		const minuteSpec = parseRRule("FREQ=HOURLY;INTERVAL=1;BYMINUTE=0");
		const next = new Date("2026-07-05T00:00:00Z");
		const now = new Date("2026-07-05T06:00:30Z");
		const result = evaluateDue(next, now, minuteSpec, tz, anchor, "runOnce");
		const fires = result.due ? 1 : 0;
		expect(fires).toBe(1);
		// Everything else is missed, not fired.
		expect(result.missed.length).toBeGreaterThan(0);
	});

	it("grace boundary: an occurrence exactly at grace age is still due", () => {
		const next = new Date("2026-07-05T09:00:00Z");
		const now = new Date(next.getTime() + MISSED_GRACE_MS);
		const result = evaluateDue(next, now, spec, tz, anchor, "skip");
		expect(result.due?.toISOString()).toBe("2026-07-05T09:00:00.000Z");
	});
});
