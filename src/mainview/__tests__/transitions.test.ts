import { getAllowedTransitions, isStatusGuardBlocked } from "../../shared/types";
import type { TaskStatus } from "../../shared/types";

describe("getAllowedTransitions", () => {
	it("todo → in-progress, completed, and cancelled", () => {
		const allowed = getAllowedTransitions("todo");
		expect(allowed).toEqual(["in-progress", "completed", "cancelled"]);
	});

	it("todo → does NOT include user-questions, review-by-ai, review-by-user", () => {
		const allowed = getAllowedTransitions("todo");
		expect(allowed).not.toContain("user-questions");
		expect(allowed).not.toContain("review-by-ai");
		expect(allowed).not.toContain("review-by-user");
	});

	it("in-progress → all except in-progress", () => {
		const allowed = getAllowedTransitions("in-progress");
		expect(allowed).not.toContain("in-progress");
		expect(allowed).toContain("todo");
		expect(allowed).toContain("completed");
		expect(allowed).toContain("cancelled");
	});

	it("completed → all except completed", () => {
		const allowed = getAllowedTransitions("completed");
		expect(allowed).not.toContain("completed");
		expect(allowed).toContain("todo");
		expect(allowed).toContain("in-progress");
	});

	it("cancelled → all except cancelled", () => {
		const allowed = getAllowedTransitions("cancelled");
		expect(allowed).not.toContain("cancelled");
		expect(allowed).toContain("todo");
	});

	it("each status never includes itself", () => {
		const statuses: TaskStatus[] = [
			"todo", "in-progress", "user-questions",
			"review-by-ai", "review-by-user", "completed", "cancelled",
		];
		for (const s of statuses) {
			expect(getAllowedTransitions(s)).not.toContain(s);
		}
	});
});

describe("isStatusGuardBlocked", () => {
	it("no guard options → never blocked", () => {
		expect(isStatusGuardBlocked("todo")).toBe(false);
		expect(isStatusGuardBlocked("todo", {})).toBe(false);
	});

	it("ifStatus: blocks when current status not in the allow-list", () => {
		expect(isStatusGuardBlocked("todo", { ifStatus: "in-progress" })).toBe(true);
		expect(isStatusGuardBlocked("in-progress", { ifStatus: "in-progress" })).toBe(false);
	});

	it("ifStatus: supports comma-separated lists with whitespace", () => {
		expect(isStatusGuardBlocked("user-questions", { ifStatus: "in-progress, user-questions" })).toBe(false);
		expect(isStatusGuardBlocked("todo", { ifStatus: "in-progress, user-questions" })).toBe(true);
	});

	it("ifStatusNot: blocks when current status is in the deny-list", () => {
		expect(isStatusGuardBlocked("todo", { ifStatusNot: "todo" })).toBe(true);
		expect(isStatusGuardBlocked("in-progress", { ifStatusNot: "todo" })).toBe(false);
	});

	it("ifStatusNot: supports comma-separated lists", () => {
		expect(isStatusGuardBlocked("completed", { ifStatusNot: "completed,cancelled" })).toBe(true);
		expect(isStatusGuardBlocked("in-progress", { ifStatusNot: "completed,cancelled" })).toBe(false);
	});
});
