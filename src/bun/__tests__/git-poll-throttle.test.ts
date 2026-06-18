import { describe, expect, it } from "vitest";
import { isProjectDueForCheck } from "../rpc-handlers/git-poll-throttle";

const ACTIVE = 60_000;
const BG = 10 * 60_000;
// A realistic epoch-scale "now"; lastRun is expressed relative to it.
const NOW = 1_700_000_000_000;

function due(over: Partial<Parameters<typeof isProjectDueForCheck>[0]>): boolean {
	return isProjectDueForCheck({
		projectId: "p1",
		activeProjectId: "p1",
		foreground: true,
		lastRunMs: NOW,
		nowMs: NOW,
		activeIntervalMs: ACTIVE,
		backgroundIntervalMs: BG,
		...over,
	});
}

describe("isProjectDueForCheck", () => {
	it("runs a never-checked project immediately", () => {
		expect(due({ lastRunMs: 0 })).toBe(true);
	});

	it("checks the active foreground project every base tick (~60s)", () => {
		expect(due({ nowMs: NOW + 60_000 })).toBe(true);
		expect(due({ nowMs: NOW + 55_000 })).toBe(true); // within drift tolerance
	});

	it("does NOT re-check the active project on a too-soon tick", () => {
		expect(due({ nowMs: NOW + 20_000 })).toBe(false);
	});

	it("throttles a background (off-screen) project to the slow interval", () => {
		expect(due({ projectId: "p2", nowMs: NOW + 60_000 })).toBe(false);
		expect(due({ projectId: "p2", nowMs: NOW + 9 * 60_000 })).toBe(false);
		expect(due({ projectId: "p2", nowMs: NOW + 10 * 60_000 })).toBe(true);
	});

	it("treats the active project as background when the app is not in the foreground", () => {
		expect(due({ foreground: false, nowMs: NOW + 60_000 })).toBe(false);
		expect(due({ foreground: false, nowMs: NOW + 10 * 60_000 })).toBe(true);
	});

	it("treats everything as background when no active project is reported", () => {
		expect(due({ activeProjectId: null, nowMs: NOW + 60_000 })).toBe(false);
	});
});
