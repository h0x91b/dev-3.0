import { describe, expect, it } from "vitest";
import type { Task, TaskMovement, TaskStatus } from "../../shared/types";
import {
	projectTaskAt,
} from "../components/agent-traffic/task-history";

const at = (minutesAgo: number) =>
	new Date(Date.parse("2026-09-08T20:00:00.000Z") - minutesAgo * 60_000).toISOString();
const ms = (minutesAgo: number) => Date.parse(at(minutesAgo));

let ids = 0;
const created = (minutesAgo: number, to: TaskStatus): TaskMovement => ({
	id: `m${++ids}`, at: at(minutesAgo), kind: "created", to, toColumnId: null,
});
const moved = (minutesAgo: number, from: TaskStatus, to: TaskStatus, toColumnId: string | null = null): TaskMovement => ({
	id: `m${++ids}`, at: at(minutesAgo), kind: "status", from, to, fromColumnId: null, toColumnId,
});

const task = (overrides: Partial<Task> = {}): Task =>
	({ id: "t", projectId: "p", seq: 1, title: "Task", description: "", status: "in-progress", ...overrides }) as Task;

describe("projectTaskAt", () => {
	it("returns the live task with no cursor", () => {
		const subject = task({ status: "completed", movements: [created(90, "todo")] });
		expect(projectTaskAt(subject, null)).toEqual({
			present: true, status: "completed", columnId: null, confidence: "recorded",
		});
	});

	it("replays creation and every transition in order", () => {
		const subject = task({
			status: "completed",
			movements: [
				created(90, "todo"),
				moved(70, "todo", "in-progress"),
				moved(40, "in-progress", "review-by-user"),
				moved(20, "review-by-user", "completed"),
			],
		});
		expect(projectTaskAt(subject, ms(95))).toMatchObject({ present: false });
		expect(projectTaskAt(subject, ms(80))).toMatchObject({ present: true, status: "todo" });
		expect(projectTaskAt(subject, ms(50))).toMatchObject({ status: "in-progress" });
		expect(projectTaskAt(subject, ms(30))).toMatchObject({ status: "review-by-user" });
		expect(projectTaskAt(subject, ms(10))).toMatchObject({ status: "completed", confidence: "recorded" });
	});

	it("is a pure function of the cursor, so scrubbing back reverses exactly", () => {
		const subject = task({
			status: "completed",
			movements: [created(90, "todo"), moved(70, "todo", "in-progress"), moved(20, "in-progress", "completed")],
		});
		const forward = [95, 80, 50, 10].map((m) => projectTaskAt(subject, ms(m)));
		const backward = [10, 50, 80, 95].map((m) => projectTaskAt(subject, ms(m))).reverse();
		expect(backward).toEqual(forward);
	});

	it("lands exactly on a movement's own instant, not one step behind", () => {
		const subject = task({ status: "completed", movements: [created(90, "todo"), moved(20, "todo", "completed")] });
		expect(projectTaskAt(subject, ms(20))).toMatchObject({ status: "completed" });
		expect(projectTaskAt(subject, ms(20) - 1)).toMatchObject({ status: "todo" });
		expect(projectTaskAt(subject, ms(90))).toMatchObject({ present: true, status: "todo" });
		expect(projectTaskAt(subject, ms(90) - 1)).toMatchObject({ present: false });
	});

	it("renders unknown rather than the live status when nothing was recorded", () => {
		const subject = task({ status: "completed" });
		// The card is completed NOW. Nothing about the past is known, so the status
		// is null — not "completed with a disclaimer", which reads as history to
		// anyone glancing at a green card. The card stays present because we cannot
		// know it did not exist.
		expect(projectTaskAt(subject, ms(600))).toEqual({
			present: true, status: null, columnId: null, confidence: "unrecorded",
		});
		expect(projectTaskAt(task({ status: "todo", movements: [] }), ms(600))).toEqual({
			present: true, status: null, columnId: null, confidence: "unrecorded",
		});
		// Live is not a reconstruction, so there the real status is the answer.
		expect(projectTaskAt(subject, null)).toMatchObject({ status: "completed", confidence: "recorded" });
	});

	it("leaves the status unknown when a partial record has no `from` to salvage", () => {
		const subject = task({
			status: "review-by-user",
			movements: [{ id: "x", at: at(40), kind: "column", to: "in-progress", toColumnId: "hold" }],
		});
		expect(projectTaskAt(subject, ms(80))).toEqual({
			present: true, status: null, columnId: null, confidence: "partial",
		});
	});

	it("salvages the pre-capture status from the first movement's `from`", () => {
		const subject = task({
			status: "review-by-user",
			movements: [moved(80, "in-progress", "user-questions"), moved(20, "user-questions", "review-by-user")],
			movementsDropped: 7,
		});
		// Before any recorded move: not a guess — the move itself says what it left.
		expect(projectTaskAt(subject, ms(120))).toEqual({
			present: true, status: "in-progress", columnId: null, confidence: "partial",
		});
		// After it, the status is a fact but the birth still is not.
		expect(projectTaskAt(subject, ms(50))).toEqual({
			present: true, status: "user-questions", columnId: null, confidence: "partial",
		});
	});

	it("calls a truncated log partial even when it still starts at creation", () => {
		const subject = task({ movements: [created(90, "todo"), moved(20, "todo", "in-progress")], movementsDropped: 3 });
		expect(projectTaskAt(subject, ms(10)).confidence).toBe("partial");
	});

	it("keeps a task that no longer exists present and honestly unknown", () => {
		expect(projectTaskAt(undefined, ms(60))).toEqual({
			present: true, status: null, columnId: null, confidence: "unrecorded",
		});
		expect(projectTaskAt(undefined, null)).toMatchObject({ confidence: "unrecorded" });
	});

	it("carries the custom column of the move it landed on", () => {
		const subject = task({
			status: "in-progress", customColumnId: "hold",
			movements: [created(90, "todo"), moved(40, "in-progress", "in-progress", "hold")],
		});
		expect(projectTaskAt(subject, ms(60)).columnId).toBeNull();
		expect(projectTaskAt(subject, ms(20)).columnId).toBe("hold");
	});

	it("tolerates movements stored out of order", () => {
		const subject = task({
			status: "completed",
			movements: [moved(20, "todo", "completed"), created(90, "todo")],
		});
		expect(projectTaskAt(subject, ms(50))).toMatchObject({ status: "todo", confidence: "recorded" });
		expect(projectTaskAt(subject, ms(95))).toMatchObject({ present: false });
	});
});
