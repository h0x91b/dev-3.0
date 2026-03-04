import { getAllowedTransitions } from "../../shared/types";
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
