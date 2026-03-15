import { describe, it, expect, vi } from "vitest";
import { getStatusLabel } from "../statusLabel";
import type { TFunction } from "../../i18n";

function makeMockT(): TFunction {
	const fn = vi.fn((key: string) => {
		const map: Record<string, string> = {
			"status.todo": "To Do",
			"status.inProgress": "Agent is Working",
			"status.userQuestions": "Has Questions",
			"status.reviewByUser": "Your Review",
			"status.completed": "Completed",
			"status.cancelled": "Cancelled",
			"status.reviewByAi": "AI Review",
			"status.reviewByColleague": "PR Review",
		};
		return map[key] ?? key;
	}) as unknown as TFunction;
	(fn as unknown as Record<string, unknown>).plural = vi.fn();
	return fn;
}

describe("getStatusLabel", () => {
	it("returns i18n translation when no project is provided", () => {
		const t = makeMockT();
		expect(getStatusLabel("todo", t)).toBe("To Do");
		expect(getStatusLabel("in-progress", t)).toBe("Agent is Working");
	});

	it("returns i18n translation when project has no custom labels", () => {
		const t = makeMockT();
		const project = {};
		expect(getStatusLabel("todo", t, project)).toBe("To Do");
	});

	it("returns i18n translation when project has empty customStatusLabels", () => {
		const t = makeMockT();
		const project = { customStatusLabels: {} };
		expect(getStatusLabel("todo", t, project)).toBe("To Do");
	});

	it("returns custom label when project has customStatusLabels for the status", () => {
		const t = makeMockT();
		const project = { customStatusLabels: { todo: "Backlog", "in-progress": "Working" } };
		expect(getStatusLabel("todo", t, project)).toBe("Backlog");
		expect(getStatusLabel("in-progress", t, project)).toBe("Working");
	});

	it("falls back to i18n for statuses without custom label", () => {
		const t = makeMockT();
		const project = { customStatusLabels: { todo: "Backlog" } };
		expect(getStatusLabel("completed", t, project)).toBe("Completed");
	});

	it("returns i18n translation when project is null", () => {
		const t = makeMockT();
		expect(getStatusLabel("todo", t, null)).toBe("To Do");
	});
});
