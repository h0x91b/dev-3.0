import { describe, expect, it } from "vitest";
import type { Task, TaskMovement, TaskStatus } from "../../shared/types";
import {
	burstPieces,
	CELEBRATION_FADE_MS,
	CELEBRATION_MS,
	completionDuration,
	FIREWORK_FLIGHT_MS,
	fireworkBursts,
	liveCompletions,
	LIVE_WINDOW_MS,
	PIECE_FLIGHT_MS,
	PIECE_WAVE_GAP_MS,
	replayCompletion,
} from "../components/agent-traffic/completion-celebration";
import type { TrafficNode } from "../components/agent-traffic/traffic-model";
import type { TrafficTimelineEvent } from "../components/agent-traffic/traffic-timeline";

const T0 = Date.parse("2026-09-09T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const ms = (minutes: number) => T0 + minutes * 60_000;

function movement(
	id: string,
	minutes: number,
	to: TaskStatus,
	kind: TaskMovement["kind"] = "status",
): TaskMovement {
	return { id, at: at(minutes), kind, to };
}

function task(movements: TaskMovement[]): Task {
	return {
		id: "task-a",
		projectId: "project",
		seq: 42,
		status: "completed",
		movements,
	} as unknown as Task;
}

function node(value: Task | undefined): TrafficNode {
	return {
		key: "node-a",
		projectId: "project",
		id: "task-a",
		seq: 42,
		title: "Ship the thing",
		task: value,
	};
}

describe("completionDuration", () => {
	it("measures the current cycle from its in-progress move", () => {
		const movements = [
			movement("m0", 0, "todo", "created"),
			movement("m1", 10, "in-progress"),
			movement("m2", 40, "completed"),
		];
		expect(completionDuration(movements, "m2")).toEqual({
			ms: 30 * 60_000,
			basis: "work-start",
		});
	});

	it("takes the FIRST work start of the cycle, not the nearest re-entry", () => {
		const movements = [
			movement("m0", 0, "todo", "created"),
			movement("m1", 10, "in-progress"),
			movement("m2", 25, "review-by-user"),
			movement("m3", 30, "in-progress"),
			movement("m4", 45, "review-by-user"),
			movement("m5", 50, "in-progress"),
			movement("m6", 70, "completed"),
		];
		// 70 − 10, not 70 − 50: a task that bounced through review three times
		// did not start work on the third bounce.
		expect(completionDuration(movements, "m6")).toEqual({
			ms: 60 * 60_000,
			basis: "work-start",
		});
	});

	it("scopes the cycle to this completion, not to the whole log", () => {
		const movements = [
			movement("m0", 0, "todo", "created"),
			movement("m1", 5, "in-progress"),
			movement("m2", 20, "completed"),
			movement("m3", 30, "in-progress"),
			movement("m4", 50, "completed"),
		];
		// The reopened cycle starts after m2, so the anchor is m3 and not m1.
		expect(completionDuration(movements, "m4")).toEqual({
			ms: 20 * 60_000,
			basis: "work-start",
		});
		expect(completionDuration(movements, "m2")).toEqual({
			ms: 15 * 60_000,
			basis: "work-start",
		});
	});

	it("refuses to reach across a previous completion for a birth", () => {
		const movements = [
			movement("m0", 0, "todo", "created"),
			movement("m1", 5, "in-progress"),
			movement("m2", 20, "completed"),
			movement("m3", 30, "review-by-user"),
			movement("m4", 50, "completed"),
		];
		// The reopened cycle recorded no work start. `created` belongs to the
		// EARLIER cycle, so measuring from it would invent a span nobody worked.
		expect(completionDuration(movements, "m4")).toBeNull();
	});

	it("a cancelled cycle closes the window too", () => {
		const movements = [
			movement("m0", 0, "todo", "created"),
			movement("m1", 5, "in-progress"),
			movement("m2", 20, "cancelled"),
			movement("m3", 30, "in-progress"),
			movement("m4", 50, "completed"),
		];
		expect(completionDuration(movements, "m4")).toEqual({
			ms: 20 * 60_000,
			basis: "work-start",
		});
	});

	it("falls back to the task's own birth, named as such, when no work start is recorded", () => {
		const movements = [
			movement("m0", 0, "todo", "created"),
			movement("m1", 90, "completed"),
		];
		expect(completionDuration(movements, "m1")).toEqual({
			ms: 90 * 60_000,
			basis: "created",
		});
	});

	it("omits the number when the birth was evicted and no work start survives", () => {
		const movements = [
			movement("m5", 30, "review-by-user"),
			movement("m6", 45, "completed"),
		];
		expect(completionDuration(movements, "m6")).toBeNull();
	});

	it("omits the number when there are no movements at all", () => {
		expect(completionDuration(undefined, "m1")).toBeNull();
		expect(completionDuration([], "m1")).toBeNull();
	});

	it("omits the number when the completion is not in the log", () => {
		expect(
			completionDuration([movement("m0", 0, "todo", "created")], "missing"),
		).toBeNull();
	});

	it("orders by time, not by array position", () => {
		const movements = [
			movement("m2", 40, "completed"),
			movement("m1", 10, "in-progress"),
			movement("m0", 0, "todo", "created"),
		];
		expect(completionDuration(movements, "m2")).toEqual({
			ms: 30 * 60_000,
			basis: "work-start",
		});
	});
});

describe("liveCompletions", () => {
	const completed = task([
		movement("m0", 0, "todo", "created"),
		movement("m1", 10, "in-progress"),
		movement("m2", 40, "completed"),
	]);

	it("celebrates nothing on the seeding pass, however fresh the completion", () => {
		const seen = new Set<string>();
		expect(liveCompletions([node(completed)], seen, ms(40), true)).toEqual([]);
		expect(seen.has("m2")).toBe(true);
	});

	it("celebrates a completion that arrived after seeding", () => {
		const seen = new Set<string>();
		liveCompletions([node(task([movement("m0", 0, "todo", "created")]))], seen, ms(0), true);
		const found = liveCompletions([node(completed)], seen, ms(40), false);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			key: "m2",
			nodeKey: "node-a",
			seq: 42,
			duration: { ms: 30 * 60_000, basis: "work-start" },
		});
	});

	it("celebrates one movement exactly once, across repeated passes", () => {
		const seen = new Set<string>();
		liveCompletions([node(task([movement("m0", 0, "todo", "created")]))], seen, ms(0), true);
		expect(liveCompletions([node(completed)], seen, ms(40), false)).toHaveLength(1);
		expect(liveCompletions([node(completed)], seen, ms(40), false)).toEqual([]);
	});

	it("ignores a completion older than the live window", () => {
		const seen = new Set<string>();
		liveCompletions([node(task([]))], seen, ms(0), true);
		const stale = ms(40) + LIVE_WINDOW_MS + 1;
		expect(liveCompletions([node(completed)], seen, stale, false)).toEqual([]);
	});

	it("ignores non-completion movements", () => {
		const seen = new Set<string>();
		liveCompletions([node(task([]))], seen, ms(0), true);
		const cancelled = task([
			movement("c0", 0, "todo", "created"),
			movement("c1", 40, "cancelled"),
		]);
		expect(liveCompletions([node(cancelled)], seen, ms(40), false)).toEqual([]);
	});
});

describe("replayCompletion", () => {
	const completed = task([
		movement("m0", 0, "todo", "created"),
		movement("m1", 10, "in-progress"),
		movement("m2", 40, "completed"),
	]);
	const event: TrafficTimelineEvent = {
		kind: "task",
		at: ms(40),
		key: "task:project:task-a:m2",
		movement: movement("m2", 40, "completed"),
		node: { projectId: "project", taskId: "task-a" },
		nodeKey: "node-a",
		seq: 42,
		title: "Ship the thing",
	};

	it("recognises a completion step and carries its duration", () => {
		expect(replayCompletion(event, [node(completed)])).toMatchObject({
			key: "m2",
			nodeKey: "node-a",
			at: ms(40),
			duration: { ms: 30 * 60_000, basis: "work-start" },
		});
	});

	it("ignores a message step and a non-completion move", () => {
		expect(replayCompletion(null, [node(completed)])).toBeNull();
		expect(
			replayCompletion(
				{ ...event, movement: movement("m1", 10, "in-progress") },
				[node(completed)],
			),
		).toBeNull();
	});

	it("ignores a completion whose card is not on this stage", () => {
		expect(replayCompletion(event, [])).toBeNull();
	});

	it("omits the duration when the replayed task carries no movement log", () => {
		expect(replayCompletion(event, [node(undefined)])?.duration).toBeNull();
	});
});

describe("burstPieces", () => {
	it("is deterministic, so a re-render redraws the same burst", () => {
		expect(burstPieces("m2")).toEqual(burstPieces("m2"));
	});

	it("gives different completions different shapes", () => {
		expect(burstPieces("m2")).not.toEqual(burstPieces("m9"));
	});

	it("stays inside a bounded spread", () => {
		for (const piece of burstPieces("m2", 20)) {
			expect(piece.distance).toBeGreaterThanOrEqual(46);
			expect(piece.distance).toBeLessThanOrEqual(108);
			expect(piece.angle).toBeGreaterThanOrEqual(-160);
			expect(piece.angle).toBeLessThanOrEqual(0);
			expect(piece.delay).toBeGreaterThanOrEqual(0);
		}
	});

	it("fires in two waves, both of them a full fan", () => {
		const pieces = burstPieces("m2", 18);
		const early = pieces.filter((piece) => piece.delay < PIECE_WAVE_GAP_MS);
		const late = pieces.filter((piece) => piece.delay >= PIECE_WAVE_GAP_MS);
		expect(early).toHaveLength(9);
		expect(late).toHaveLength(9);
		// Each wave spans the fan rather than half of it.
		for (const wave of [early, late]) {
			expect(Math.min(...wave.map((piece) => piece.angle))).toBeLessThan(-140);
			expect(Math.max(...wave.map((piece) => piece.angle))).toBeGreaterThan(-40);
		}
	});

	it("lands every piece before the celebration fades", () => {
		for (const piece of burstPieces("m2", 18)) {
			expect(piece.delay + PIECE_FLIGHT_MS).toBeLessThanOrEqual(
				CELEBRATION_MS - CELEBRATION_FADE_MS,
			);
		}
	});
});

describe("fireworkBursts", () => {
	it("is deterministic, so a replayed completion draws the same show", () => {
		expect(fireworkBursts("m2")).toEqual(fireworkBursts("m2"));
		expect(fireworkBursts("m2")).not.toEqual(fireworkBursts("m9"));
	});

	it("draws a finite number of sparks and no more", () => {
		const bursts = fireworkBursts("m2");
		expect(bursts).toHaveLength(4);
		expect(bursts.flatMap((burst) => burst.sparks)).toHaveLength(36);
	});

	it("keeps every burst clear of the badge above the card's top centre", () => {
		for (const burst of fireworkBursts("m2")) {
			// Either off to a shoulder, or high enough to clear the badge entirely.
			expect(Math.abs(burst.x - 0.5) > 0.25 || burst.y < -0.15).toBe(true);
		}
	});

	it("burns out before the celebration fades", () => {
		for (const burst of fireworkBursts("m2")) {
			expect(burst.delay + FIREWORK_FLIGHT_MS).toBeLessThanOrEqual(
				CELEBRATION_MS - CELEBRATION_FADE_MS,
			);
		}
	});
});
